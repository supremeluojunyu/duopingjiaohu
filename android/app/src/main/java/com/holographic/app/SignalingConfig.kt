package com.holographic.app

object SignalingConfig {
    private const val DEFAULT_SERVER_URL = "ws://124.220.4.69:9000/ws"

    private var serverUrl: String? = null

    fun setServerUrl(url: String) {
        serverUrl = normalizeUrl(url)
    }

    fun getServerUrl(): String = serverUrl ?: DEFAULT_SERVER_URL

    private fun normalizeUrl(url: String): String {
        var normalized = url.trim()
        if (normalized.isEmpty()) return DEFAULT_SERVER_URL

        when {
            normalized.startsWith("https://") ->
                normalized = "wss://" + normalized.removePrefix("https://")
            normalized.startsWith("http://") ->
                normalized = "ws://" + normalized.removePrefix("http://")
            !normalized.startsWith("ws://") && !normalized.startsWith("wss://") ->
                normalized = "ws://$normalized"
        }

        normalized = normalized.removeSuffix("/")
        if (!normalized.endsWith("/ws")) {
            normalized += "/ws"
        }
        return normalized
    }
}
