package com.holographic.app

import android.util.Log
import com.google.gson.JsonParser
import okhttp3.OkHttpClient
import okhttp3.Request
import org.webrtc.PeerConnection
import java.util.concurrent.TimeUnit

object IceConfigFetcher {
    private const val TAG = "IceConfigFetcher"

    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    private val fallback = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
        PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer()
    )

    fun httpBaseFromSignalingUrl(signalingUrl: String): String {
        return signalingUrl
            .replace("wss://", "https://")
            .replace("ws://", "http://")
            .removeSuffix("/ws")
            .removeSuffix("/")
    }

    fun fetch(signalingUrl: String): List<PeerConnection.IceServer> {
        val url = "${httpBaseFromSignalingUrl(signalingUrl)}/config/ice"
        return try {
            val request = Request.Builder().url(url).get().build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "ICE 配置请求失败: ${response.code}")
                    return fallback
                }
                val body = response.body?.string() ?: return fallback
                val json = JsonParser.parseString(body).asJsonObject
                val servers = json.getAsJsonArray("iceServers") ?: return fallback
                val result = mutableListOf<PeerConnection.IceServer>()
                for (el in servers) {
                    val obj = el.asJsonObject
                    val urlsEl = obj.get("urls")
                    val urls = when {
                        urlsEl == null -> continue
                        urlsEl.isJsonArray -> urlsEl.asJsonArray.map { it.asString }
                        else -> listOf(urlsEl.asString)
                    }
                    val builder = PeerConnection.IceServer.builder(urls)
                    if (obj.has("username")) builder.setUsername(obj.get("username").asString)
                    if (obj.has("credential")) builder.setPassword(obj.get("credential").asString)
                    result.add(builder.createIceServer())
                }
                if (result.isEmpty()) fallback else result
            }
        } catch (e: Exception) {
            Log.w(TAG, "拉取 ICE 配置失败: ${e.message}")
            fallback
        }
    }
}
