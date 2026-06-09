package com.holographic.app

import android.content.Intent
import android.net.Uri
import android.util.Log
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

object AppUpdateChecker {
    private const val TAG = "AppUpdateChecker"
    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()
    private val gson = Gson()

    data class ReleaseInfo(
        @SerializedName("versionName") val versionName: String = "",
        @SerializedName("versionCode") val versionCode: Int = 0,
        @SerializedName("downloadUrl") val downloadUrl: String? = null,
        @SerializedName("available") val available: Boolean = false,
        @SerializedName("releaseNotes") val releaseNotes: String = "",
    )

    fun httpBaseFromSignaling(serverUrl: String): String {
        val trimmed = serverUrl.trim().trimEnd('/')
        return when {
            trimmed.startsWith("ws://") -> "http://${trimmed.removePrefix("ws://").removeSuffix("/ws")}"
            trimmed.startsWith("wss://") -> "https://${trimmed.removePrefix("wss://").removeSuffix("/ws")}"
            else -> trimmed.removeSuffix("/ws")
        }
    }

    fun fetchRelease(serverUrl: String): ReleaseInfo? {
        val base = httpBaseFromSignaling(serverUrl)
        val request = Request.Builder()
            .url("$base/api/app/version")
            .get()
            .build()
        return try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val body = response.body?.string() ?: return null
                gson.fromJson(body, ReleaseInfo::class.java)
            }
        } catch (e: Exception) {
            Log.w(TAG, "fetchRelease failed", e)
            null
        }
    }

    fun openDownloadUrl(context: android.content.Context, url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        context.startActivity(intent)
    }
}
