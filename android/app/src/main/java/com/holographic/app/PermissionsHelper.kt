package com.holographic.app

import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import android.Manifest

object PermissionsHelper {
    val REQUIRED = arrayOf(
        Manifest.permission.CAMERA,
        Manifest.permission.RECORD_AUDIO
    )

    fun allGranted(context: Context): Boolean =
        REQUIRED.all {
            ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
        }
}
