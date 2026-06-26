package com.holographic.app

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import okhttp3.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class SignalingClient(private val url: String) {
    companion object {
        private const val TAG = "SignalingClient"
    }

    private val gson = Gson()
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private var messageHandler: ((SignalingMessage) -> Unit)? = null
    private var onLatency: ((Long) -> Unit)? = null
    private var onReconnectExhausted: (() -> Unit)? = null
    private val connected = AtomicBoolean(false)

    private var reconnectAttempts = 0
    private var shouldReconnect = true
    private val maxReconnectAttempts = 10
    private val reconnectIntervalMs = 3000L
    private val reconnectHandler = Handler(Looper.getMainLooper())
    private var reconnectRunnable: Runnable? = null
    private var lastJoinPayload: Map<String, Any?>? = null
    @Volatile
    private var pingThread: Thread? = null
    private val reconnectPending = java.util.concurrent.atomic.AtomicBoolean(false)

    data class SignalingMessage(
        val type: String,
        val payload: JsonObject?,
        val timestamp: Long = 0,
        val from: String? = null,
        val to: String? = null
    )

    fun connect(): Boolean {
        shouldReconnect = true
        reconnectAttempts = 0
        cancelReconnect()
        return connectInternal(blocking = true)
    }

    fun disconnect() {
        shouldReconnect = false
        cancelReconnect()
        connected.set(false)
        stopPing()
        webSocket?.close(1000, null)
        webSocket = null
    }

    fun isConnected(): Boolean = connected.get()

    fun onMessage(handler: (SignalingMessage) -> Unit) {
        messageHandler = handler
    }

    fun setLatencyCallback(cb: (Long) -> Unit) {
        onLatency = cb
    }

    fun setReconnectExhaustedCallback(cb: () -> Unit) {
        onReconnectExhausted = cb
    }

    fun setJoinPayload(payload: Map<String, Any?>) {
        lastJoinPayload = payload
    }

    /** @return 是否成功写入 WebSocket 发送队列 */
    fun send(type: String, payload: Map<String, Any?>, to: String? = null): Boolean {
        if (!connected.get()) {
            Log.w(TAG, "send 失败: 未连接 type=$type")
            return false
        }
        val ws = webSocket
        if (ws == null) {
            Log.w(TAG, "send 失败: WebSocket 为空 type=$type")
            return false
        }

        val msg = mutableMapOf<String, Any?>(
            "type" to type,
            "payload" to payload,
            "timestamp" to System.currentTimeMillis()
        )
        if (to != null) msg["to"] = to

        val ok = ws.send(gson.toJson(msg))
        if (!ok) {
            Log.w(TAG, "send 失败: 连接已关闭或发送队列不可用 type=$type")
        }
        return ok
    }

    fun startPing(intervalMs: Long = 10000) {
        stopPing()
        val thread = Thread {
            try {
                while (connected.get() && !Thread.currentThread().isInterrupted) {
                    send("ping", emptyMap())
                    Thread.sleep(intervalMs)
                }
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }.apply { isDaemon = true; name = "SignalingPing" }
        pingThread = thread
        thread.start()
    }

    private fun stopPing() {
        pingThread?.interrupt()
        pingThread = null
    }

    private fun connectInternal(blocking: Boolean): Boolean {
        val latch = if (blocking) CountDownLatch(1) else null
        var success = false

        webSocket?.close(1000, "reconnecting")
        webSocket = null
        connected.set(false)

        val request = Request.Builder().url(url).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connected.set(true)
                reconnectAttempts = 0
                reconnectPending.set(false)
                success = true
                latch?.countDown()

                lastJoinPayload?.let { send("join", it) }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val json = JsonParser.parseString(text).asJsonObject
                    val msg = SignalingMessage(
                        type = json.get("type")?.asString ?: "",
                        payload = json.getAsJsonObject("payload"),
                        timestamp = json.get("timestamp")?.asLong ?: 0,
                        from = json.get("from")?.asString,
                        to = json.get("to")?.asString
                    )
                    if (msg.type == "pong" && msg.payload?.has("sentAt") == true) {
                        onLatency?.invoke(System.currentTimeMillis() - msg.payload.get("sentAt").asLong)
                    }
                    messageHandler?.invoke(msg)
                } catch (_: Exception) { }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                connected.set(false)
                latch?.countDown()
                if (shouldReconnect) {
                    scheduleReconnect()
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                connected.set(false)
            }
        })

        if (blocking) {
            latch?.await(10, TimeUnit.SECONDS)
            return success
        }
        return true
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect) return
        if (!reconnectPending.compareAndSet(false, true)) return

        if (reconnectAttempts >= maxReconnectAttempts) {
            shouldReconnect = false
            reconnectPending.set(false)
            cancelReconnect()
            onReconnectExhausted?.invoke()
            return
        }

        val delay = reconnectIntervalMs * (1L shl reconnectAttempts.coerceAtMost(5))
        reconnectAttempts++

        cancelReconnect()
        reconnectRunnable = Runnable {
            reconnectPending.set(false)
            if (shouldReconnect) {
                connectInternal(blocking = false)
            }
        }
        reconnectHandler.postDelayed(reconnectRunnable!!, delay)
    }

    private fun cancelReconnect() {
        reconnectRunnable?.let { reconnectHandler.removeCallbacks(it) }
        reconnectRunnable = null
    }
}
