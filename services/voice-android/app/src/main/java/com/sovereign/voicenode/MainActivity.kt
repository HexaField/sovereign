package com.sovereign.voicenode

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Minimal launcher activity — configures the server URL and
 * starts/stops the foreground service.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val PERM_REQUEST = 100
    }

    private lateinit var serverInput: EditText
    private lateinit var statusText: TextView
    private lateinit var toggleButton: Button

    private var serviceRunning = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        serverInput = findViewById(R.id.serverInput)
        statusText = findViewById(R.id.statusText)
        toggleButton = findViewById(R.id.toggleButton)

        // Load saved server URL
        val prefs = getSharedPreferences("sovereign_voice", MODE_PRIVATE)
        serverInput.setText(prefs.getString("server_url", "https://arcadia.tail300736.ts.net:5801"))

        toggleButton.setOnClickListener {
            if (serviceRunning) stopVoiceService()
            else startVoiceService()
        }

        requestPermissions()
    }

    private fun startVoiceService() {
        val url = serverInput.text.toString().trimEnd('/')
        if (url.isBlank()) {
            statusText.text = "Enter a server URL"
            return
        }

        // Save URL
        getSharedPreferences("sovereign_voice", MODE_PRIVATE)
            .edit().putString("server_url", url).apply()

        val hasModel = WakeWordDetector.hasModel(this)

        val intent = Intent(this, VoiceNodeService::class.java).apply {
            putExtra(VoiceNodeService.EXTRA_SERVER_URL, url)
        }

        ContextCompat.startForegroundService(this, intent)
        serviceRunning = true
        toggleButton.text = "Stop"
        statusText.text = if (hasModel) "Listening for wake word..."
            else "Downloading wake word model from server..."
    }

    private fun stopVoiceService() {
        stopService(Intent(this, VoiceNodeService::class.java))
        serviceRunning = false
        toggleButton.text = "Start"
        statusText.text = "Stopped"
    }

    private fun requestPermissions() {
        val needed = mutableListOf<String>()

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.RECORD_AUDIO)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed.add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(
                this,
                needed.toTypedArray(),
                PERM_REQUEST,
            )
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERM_REQUEST) {
            val denied = permissions.zip(grantResults.toList())
                .filter { it.second != PackageManager.PERMISSION_GRANTED }
                .map { it.first }
            if (denied.isNotEmpty()) {
                statusText.text = "Missing permissions: ${denied.joinToString()}"
            }
        }
    }
}
