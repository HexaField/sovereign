package com.sovereign.voicenode

import android.Manifest
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat

/**
 * Launcher activity — shows detection state visually and controls
 * the foreground wake word service.
 *
 * States:
 *   idle       → grey ring, pause icon
 *   listening  → blue ring (pulsing), mic icon
 *   wake_detected → green flash, bell icon + chime
 *   capturing  → amber ring (pulsing), recording icon
 *   sending    → blue ring, upload icon
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val PERM_REQUEST = 100
    }

    private lateinit var serverInput: EditText
    private lateinit var statusText: TextView
    private lateinit var scoreText: TextView
    private lateinit var lastTranscription: TextView
    private lateinit var toggleButton: Button
    private lateinit var stateRing: View
    private lateinit var stateEmoji: TextView

    private var serviceRunning = false
    private var pulseAnimator: ObjectAnimator? = null
    private var toneGenerator: ToneGenerator? = null

    // Ring colours
    private val colorIdle = Color.parseColor("#333355")
    private val colorListening = Color.parseColor("#2196F3")
    private val colorWake = Color.parseColor("#4CAF50")
    private val colorCapturing = Color.parseColor("#FF9800")
    private val colorSending = Color.parseColor("#2196F3")

    private val scoreReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val score = intent.getFloatExtra("score", -1f)
            if (score >= 0f) {
                runOnUiThread {
                    scoreText.text = "score %.4f".format(score)
                }
            }
        }
    }

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val state = intent.getStringExtra("state") ?: return
            runOnUiThread { applyState(state) }
        }
    }

    private val transcriptionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val text = intent.getStringExtra("text") ?: return
            runOnUiThread {
                lastTranscription.text = "\"$text\""
                lastTranscription.setTextColor(Color.parseColor("#AAAACC"))
                // Fade after 8 seconds
                lastTranscription.animate().alpha(0.4f).setStartDelay(8000).setDuration(2000).start()
                lastTranscription.alpha = 1f
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        serverInput = findViewById(R.id.serverInput)
        statusText = findViewById(R.id.statusText)
        scoreText = findViewById(R.id.scoreText)
        lastTranscription = findViewById(R.id.lastTranscription)
        toggleButton = findViewById(R.id.toggleButton)
        stateRing = findViewById(R.id.stateRing)
        stateEmoji = findViewById(R.id.stateEmoji)

        // Load saved server URL
        val prefs = getSharedPreferences("sovereign_voice", MODE_PRIVATE)
        serverInput.setText(prefs.getString("server_url", "https://arcadia.tail300736.ts.net:5801"))

        toggleButton.setOnClickListener {
            if (serviceRunning) stopVoiceService()
            else startVoiceService()
        }

        try {
            toneGenerator = ToneGenerator(AudioManager.STREAM_MUSIC, 100)
        } catch (_: Exception) {}

        requestPermissions()
    }

    private fun applyState(state: String) {
        pulseAnimator?.cancel()
        stateRing.scaleX = 1f
        stateRing.scaleY = 1f

        when (state) {
            "listening" -> {
                setRingColor(colorListening)
                stateEmoji.text = "🎙"
                statusText.text = "Listening..."
                startPulse(0.95f, 1.05f, 2000)
            }
            "wake_detected" -> {
                setRingColor(colorWake)
                stateEmoji.text = "✓"
                statusText.text = "Wake word detected!"
                // Two-tone chime — ascending notes
                try {
                    toneGenerator?.startTone(ToneGenerator.TONE_DTMF_D, 120)
                    stateRing.postDelayed({
                        try { toneGenerator?.startTone(ToneGenerator.TONE_DTMF_A, 120) } catch (_: Exception) {}
                    }, 130)
                } catch (_: Exception) {}
                // Flash the ring
                stateRing.animate().scaleX(1.15f).scaleY(1.15f).setDuration(200)
                    .withEndAction { stateRing.animate().scaleX(1f).scaleY(1f).setDuration(200).start() }
                    .start()
            }
            "capturing" -> {
                setRingColor(colorCapturing)
                stateEmoji.text = "⏺"
                statusText.text = "Listening — speak now"
                startPulse(0.97f, 1.03f, 800)
            }
            "sending" -> {
                setRingColor(colorSending)
                stateEmoji.text = "↑"
                statusText.text = "Sending..."
            }
            "tts_playing" -> {
                setRingColor(Color.parseColor("#9C27B0"))  // purple for playback
                stateEmoji.text = "🔊"
                statusText.text = "Playing response..."
                startPulse(0.98f, 1.02f, 1200)
            }
            else -> {
                setRingColor(colorIdle)
                stateEmoji.text = "⏸"
                statusText.text = "Ready"
            }
        }
    }

    private fun setRingColor(color: Int) {
        val bg = stateRing.background
        if (bg is GradientDrawable) {
            bg.setStroke(6, color)
        } else {
            // Programmatic fallback
            val shape = GradientDrawable()
            shape.shape = GradientDrawable.OVAL
            shape.setColor(Color.parseColor("#0D0D1A"))
            shape.setStroke(6, color)
            stateRing.background = shape
        }
    }

    private fun startPulse(from: Float, to: Float, duration: Long) {
        pulseAnimator = ObjectAnimator.ofFloat(stateRing, "scaleX", from, to).apply {
            this.duration = duration
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            interpolator = AccelerateDecelerateInterpolator()
            start()
        }
        // Sync Y scale
        ObjectAnimator.ofFloat(stateRing, "scaleY", from, to).apply {
            this.duration = duration
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            interpolator = AccelerateDecelerateInterpolator()
            start()
        }
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

        val intent = Intent(this, VoiceNodeService::class.java).apply {
            putExtra(VoiceNodeService.EXTRA_SERVER_URL, url)
        }

        androidx.core.content.ContextCompat.startForegroundService(this, intent)
        serviceRunning = true
        toggleButton.text = "Stop"
        applyState("listening")

        registerReceivers()
    }

    private fun stopVoiceService() {
        stopService(Intent(this, VoiceNodeService::class.java))
        serviceRunning = false
        toggleButton.text = "Start"
        applyState("idle")
        unregisterReceivers()
    }

    private fun registerReceivers() {
        val scoreFilter = IntentFilter(VoiceNodeService.ACTION_SCORE_UPDATE)
        val stateFilter = IntentFilter(VoiceNodeService.ACTION_STATE_CHANGE)
        val transcriptionFilter = IntentFilter(VoiceNodeService.ACTION_TRANSCRIPTION)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(scoreReceiver, scoreFilter, Context.RECEIVER_NOT_EXPORTED)
            registerReceiver(stateReceiver, stateFilter, Context.RECEIVER_NOT_EXPORTED)
            registerReceiver(transcriptionReceiver, transcriptionFilter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(scoreReceiver, scoreFilter)
            registerReceiver(stateReceiver, stateFilter)
            registerReceiver(transcriptionReceiver, transcriptionFilter)
        }
    }

    private fun unregisterReceivers() {
        try { unregisterReceiver(scoreReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(stateReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(transcriptionReceiver) } catch (_: Exception) {}
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

    override fun onDestroy() {
        pulseAnimator?.cancel()
        toneGenerator?.release()
        unregisterReceivers()
        super.onDestroy()
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
