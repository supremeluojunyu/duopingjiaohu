package com.holographic.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.util.Log
import java.net.Inet4Address

/**
 * 投屏时强制 WebRTC 走 WiFi，避免双网卡（WiFi + 蜂窝）下 ICE 只暴露公网 srflx(106.x) 导致与局域网电脑无法配对。
 */
object WiFiNetworkBinder {
    private const val TAG = "WiFiNetworkBinder"

    @Volatile
    private var boundNetwork: Network? = null

    fun bindToWifi(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val wifi = findWifiNetwork(cm) ?: run {
            Log.w(TAG, "未找到可用 WiFi 网络")
            return false
        }
        val ok = cm.bindProcessToNetwork(wifi)
        if (ok) {
            boundNetwork = wifi
            Log.i(TAG, "已 bindProcessToNetwork WiFi: ${getIpv4(wifi, cm)}")
        } else {
            Log.w(TAG, "bindProcessToNetwork WiFi 失败")
        }
        return ok
    }

    fun unbind(context: Context) {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        cm.bindProcessToNetwork(null)
        boundNetwork = null
        Log.i(TAG, "已解除 WiFi 网络绑定")
    }

    fun getWifiIpv4(context: Context): String? {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val wifi = boundNetwork ?: findWifiNetwork(cm) ?: return null
        return getIpv4(wifi, cm)
    }

    private fun findWifiNetwork(cm: ConnectivityManager): Network? {
        for (network in cm.allNetworks) {
            val caps = cm.getNetworkCapabilities(network) ?: continue
            if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue
            if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue
            return network
        }
        return null
    }

    private fun getIpv4(network: Network, cm: ConnectivityManager): String? {
        val props: LinkProperties? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            cm.getLinkProperties(network)
        } else {
            null
        }
        return props?.linkAddresses
            ?.mapNotNull { it.address }
            ?.filterIsInstance<Inet4Address>()
            ?.firstOrNull { !it.isLoopbackAddress }
            ?.hostAddress
    }
}
