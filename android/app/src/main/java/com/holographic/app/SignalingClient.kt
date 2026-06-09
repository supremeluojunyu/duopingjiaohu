package com.holographic.app

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import okhttp3.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class SignalingClient(private val url: String) {
    private val gson = Gson()
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private var messageHandler: ((SignalingMessage) -> Unit)? = null
    private var onLatency: ((Long) -> Unit)? = null
    private val connected = AtomicBoolean(false)

    data class SignalingMessage(
        val type: String,
        val payload: JsonObject?,
        val timestamp: Long = 0,
        val from: String? = null,
        val to: String? = null
    )

    fun connect(): Boolean {
        val latch = CountDownLatch(1)
        var success = false
        val request = Request.Builder().url(url).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connected.set(true)
                success = true
                latch.countDown()
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
                latch.countDown()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                connected.set(false)
            }
        })
        latch.await(10, TimeUnit.SECONDS)
        return success
    }

    fun disconnect() {
        webSocket?.close(1000, null)
        connected.set(false)
    }

    fun isConnected(): Boolean = connected.get()

    fun onMessage(handler: (SignalingMessage) -> Unit) {
        messageHandler = handler
    }

    fun setLatencyCallback(cb: (Long) -> Unit) {
        onLatency = cb
    }

    fun send(type: String, payload: Map<String, Any?>, to: String? = null) {
        val msg = mutableMapOf<String, Any?>(
            "type" to type,
            "payload" to payload,
            "timestamp" to System.currentTimeMillis()
        )
        if (to != null) msg["to"] = to
        webSocket?.send(gson.toJson(msg))
    }

    fun startPing(intervalMs: Long = 3000) {
        Thread {
            while (connected.get()) {
                send("ping", emptyMap())
                Thread.sleep(intervalMs)
            }
        }.apply { isDaemon = true; start() }
    }
}
