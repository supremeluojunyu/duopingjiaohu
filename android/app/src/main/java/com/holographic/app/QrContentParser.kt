package com.holographic.app

import android.net.Uri

object QrContentParser {
    /** 解析扫码内容：支持房间号、带 room 参数的 URL、下载页 URL */
    fun parse(content: String): ScanResult {
        val trimmed = content.trim()
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            val uri = Uri.parse(trimmed)
            val page = uri.getQueryParameter("page")
            if (page == "download") {
                return ScanResult.DownloadPage(uri.getQueryParameter("server"))
            }
            uri.getQueryParameter("room")?.takeIf { it.isNotBlank() }?.let { room ->
                val server = uri.getQueryParameter("server")?.takeIf { it.isNotBlank() }
                return ScanResult.JoinRoom(room.uppercase(), server)
            }
        }
        return ScanResult.JoinRoom(trimmed.uppercase(), null)
    }

    sealed class ScanResult {
        data class JoinRoom(val roomId: String, val serverUrl: String? = null) : ScanResult()
        data class DownloadPage(val serverUrl: String?) : ScanResult()
    }
}
