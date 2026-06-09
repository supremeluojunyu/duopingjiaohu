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
            uri.getQueryParameter("room")?.takeIf { it.isNotBlank() }?.let {
                return ScanResult.JoinRoom(it.uppercase())
            }
        }
        return ScanResult.JoinRoom(trimmed.uppercase())
    }

    sealed class ScanResult {
        data class JoinRoom(val roomId: String) : ScanResult()
        data class DownloadPage(val serverUrl: String?) : ScanResult()
    }
}
