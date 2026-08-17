package com.sovereign.voicenode

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Base64
import android.util.Log
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.math.sqrt

/**
 * Foreground service for always-on wake word detection.
 *
 * Flow: Mic → WakeWordDetector → VAD capture → POST to Sovereign → WS playback
 *
 * Runs as a foreground service so Android keeps the mic open even when
 * the screen turns off.
 */
class VoiceNodeService : Service() {
    companion object {
        private const val TAG = "VoiceNodeService"
        private const val CHANNEL_ID = "sovereign_voice_node"
        private const val NOTIFICATION_ID = 1
        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_THRESHOLD = "threshold"
        const val ACTION_SCORE_UPDATE = "com.sovereign.voicenode.SCORE_UPDATE"
        const val ACTION_STATE_CHANGE = "com.sovereign.voicenode.STATE_CHANGE"
        const val ACTION_TRANSCRIPTION = "com.sovereign.voicenode.TRANSCRIPTION"
        // States: idle, listening, wake_detected, capturing, sending, tts_playing
        // Device name announced to the server — TTS routes by this name
        const val DEVICE_NAME = "Josh Phone"
    }

    private var serverUrl = "https://arcadia.tail300736.ts.net:5801"
    private var deviceId = ""
    private var wakeLock: PowerManager.WakeLock? = null

    private var detector: WakeWordDetector? = null
    private var audioRecord: AudioRecord? = null
    private var wsClient: WebSocket? = null
    // Trust all certs for Tailscale Serve's internal TLS termination
    private val trustAllCerts = arrayOf<TrustManager>(object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
    })
    private val sslContext = SSLContext.getInstance("TLS").apply {
        init(null, trustAllCerts, SecureRandom())
    }
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .sslSocketFactory(sslContext.socketFactory, trustAllCerts[0] as X509TrustManager)
        .hostnameVerifier { _, _ -> true }
        .build()

    @Volatile
    private var running = false

    private var captureThread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        deviceId = getOrCreateDeviceId()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        serverUrl = intent?.getStringExtra(EXTRA_SERVER_URL) ?: serverUrl
        val threshold = intent?.getFloatExtra(EXTRA_THRESHOLD, 0.5f) ?: 0.5f

        startForeground(NOTIFICATION_ID, buildNotification("Listening for wake word..."))
        acquireWakeLock()

        if (!running) {
            // Download model from Sovereign if not cached locally
            if (!WakeWordDetector.hasModel(this)) {
                Thread {
                    if (downloadModel()) {
                        running = true
                        detector = WakeWordDetector(this, threshold = threshold)
                        startDetection()
                        connectWebSocket()
                    } else {
                        Log.e(TAG, "No wake word model available — stopping service")
                        updateNotification("No wake word model — download from server failed")
                        stopSelf()
                    }
                }.start()
            } else {
                running = true
                detector = WakeWordDetector(this, threshold = threshold)
                startDetection()
                connectWebSocket()
            }
        }

        return START_STICKY
    }

    /**
     * Download all ONNX models needed for the wake word pipeline.
     * OpenWakeWord uses 3 stages: melspectrogram → embedding → wake word.
     */
    private fun downloadModel(): Boolean {
        Log.i(TAG, "Downloading wake word pipeline models from $serverUrl")
        updateNotification("Downloading wake word models...")

        for (modelName in WakeWordDetector.MODEL_FILES) {
            if (java.io.File(filesDir, modelName).let { it.exists() && it.length() > 0 }) {
                Log.i(TAG, "Model already cached: $modelName")
                continue
            }

            val url = "$serverUrl/api/voice/wake-model/$modelName"
            try {
                val request = Request.Builder().url(url).build()
                val response = httpClient.newCall(request).execute()
                if (response.isSuccessful) {
                    val body = response.body ?: return false
                    val modelFile = java.io.File(filesDir, modelName)
                    modelFile.outputStream().use { out ->
                        body.byteStream().use { it.copyTo(out) }
                    }
                    Log.i(TAG, "Downloaded $modelName: ${modelFile.length()} bytes")
                } else {
                    Log.w(TAG, "Download failed for $modelName: ${response.code}")
                    return false
                }
            } catch (e: Exception) {
                Log.e(TAG, "Download error for $modelName", e)
                return false
            }
        }
        return true
    }

    override fun onDestroy() {
        running = false
        captureThread?.interrupt()
        audioRecord?.stop()
        audioRecord?.release()
        detector?.close()
        wsClient?.close(1000, "Service stopped")
        wakeLock?.release()
        super.onDestroy()
    }

    // --- Wake word detection ---

    private fun startDetection() {
        val bufferSize = AudioRecord.getMinBufferSize(
            WakeWordDetector.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_FLOAT,
        )

        audioRecord = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            WakeWordDetector.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_FLOAT,
            maxOf(bufferSize, WakeWordDetector.FRAME_SAMPLES * 4),
        )

        captureThread = Thread({
            audioRecord?.startRecording()
            Log.i(TAG, "Listening for wake word (server=$serverUrl, device=$deviceId)")
            broadcastState("listening")

            val frame = FloatArray(WakeWordDetector.FRAME_SAMPLES)
            var frameCount = 0
            // Hard energy gate — ignore frames quieter than ambient noise floor.
            // Float audio from AudioRecord: 0.003 RMS ≈ -50dB, well below speech.
            val noiseFloorRms = 0.005f

            while (running) {
                val read = audioRecord?.read(frame, 0, frame.size, AudioRecord.READ_BLOCKING) ?: -1
                if (read != frame.size) continue

                frameCount++

                // Compute frame energy
                var sumSq = 0.0
                for (s in frame) sumSq += s * s
                val rms = sqrt(sumSq / frame.size).toFloat()

                // Gate: skip detection entirely for quiet frames
                if (rms < noiseFloorRms) {
                    if (frameCount % 25 == 0) {
                        val intent = Intent(ACTION_SCORE_UPDATE)
                        intent.putExtra("score", 0f)
                        intent.setPackage(packageName)
                        sendBroadcast(intent)
                    }
                    continue
                }

                val score = detector?.detectScore(frame) ?: -1f

                // Log score periodically for debugging
                if (frameCount % 25 == 0 && score >= 0f) {
                    Log.d(TAG, "Wake score: %.4f rms: %.4f (threshold: %.2f)".format(score, rms, 0.5f))
                    // Broadcast to activity for UI display
                    val intent = Intent(ACTION_SCORE_UPDATE)
                    intent.putExtra("score", score)
                    intent.setPackage(packageName)
                    sendBroadcast(intent)
                }

                if (score >= 0.5f) {
                    Log.i(TAG, "WAKE WORD DETECTED! score=%.3f rms=%.4f".format(score, rms))
                    broadcastState("wake_detected")
                    updateNotification("Capturing speech...")
                    val captured = captureSpeech()
                    if (captured != null) {
                        broadcastState("sending")
                        updateNotification("Sending...")
                        sendAudio(captured)
                    }
                    broadcastState("listening")
                    updateNotification("Listening for wake word...")
                }
            }
        }, "voice-node-detect").also { it.start() }
    }

    /**
     * Record speech after wake word until silence or max duration.
     * Returns WAV bytes or null if nothing captured.
     */
    private fun captureSpeech(): ByteArray? {
        broadcastState("capturing")
        val maxDurationMs = 30_000L
        val silenceTimeoutMs = 1_500L
        val silenceThreshold = 0.01f  // RMS threshold for float audio

        val frames = mutableListOf<FloatArray>()
        val frame = FloatArray(WakeWordDetector.FRAME_SAMPLES)
        val startTime = System.currentTimeMillis()
        var silenceStart: Long? = null

        while (running) {
            val elapsed = System.currentTimeMillis() - startTime
            if (elapsed >= maxDurationMs) break

            val read = audioRecord?.read(frame, 0, frame.size, AudioRecord.READ_BLOCKING) ?: -1
            if (read != frame.size) continue

            frames.add(frame.copyOf())

            // Energy-based VAD
            var sumSq = 0.0
            for (s in frame) sumSq += s * s
            val rms = sqrt(sumSq / frame.size).toFloat()

            if (rms < silenceThreshold) {
                if (silenceStart == null) silenceStart = System.currentTimeMillis()
                else if (System.currentTimeMillis() - silenceStart >= silenceTimeoutMs) {
                    Log.i(TAG, "Silence detected — capture complete (${elapsed}ms)")
                    break
                }
            } else {
                silenceStart = null
            }
        }

        if (frames.isEmpty()) return null

        // Post-capture energy gate — reject if overall RMS stays below speech threshold
        var totalSumSq = 0.0
        var totalSamples = 0
        for (f in frames) {
            for (s in f) totalSumSq += s * s
            totalSamples += f.size
        }
        val overallRms = sqrt(totalSumSq / totalSamples).toFloat()
        if (overallRms < 0.01f) {
            Log.i(TAG, "Captured audio too quiet (rms=%.4f) — discarding".format(overallRms))
            return null
        }

        // Encode as 16-bit PCM WAV
        return encodeWav(frames)
    }

    private fun encodeWav(frames: List<FloatArray>): ByteArray {
        val totalSamples = frames.sumOf { it.size }
        val dataSize = totalSamples * 2  // 16-bit = 2 bytes per sample

        val baos = ByteArrayOutputStream(44 + dataSize)
        val dos = DataOutputStream(baos)

        // WAV header
        dos.writeBytes("RIFF")
        dos.writeIntLE(36 + dataSize)
        dos.writeBytes("WAVE")
        dos.writeBytes("fmt ")
        dos.writeIntLE(16)       // chunk size
        dos.writeShortLE(1)      // PCM
        dos.writeShortLE(1)      // mono
        dos.writeIntLE(WakeWordDetector.SAMPLE_RATE)
        dos.writeIntLE(WakeWordDetector.SAMPLE_RATE * 2)  // byte rate
        dos.writeShortLE(2)      // block align
        dos.writeShortLE(16)     // bits per sample
        dos.writeBytes("data")
        dos.writeIntLE(dataSize)

        // Audio data — convert float32 to int16
        for (frame in frames) {
            for (sample in frame) {
                val clamped = sample.coerceIn(-1f, 1f)
                val int16 = (clamped * 32767).toInt().toShort()
                dos.writeShortLE(int16.toInt())
            }
        }

        return baos.toByteArray()
    }

    // --- Network ---

    private fun sendAudio(wavData: ByteArray) {
        Thread {
            try {
                val body = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart(
                        "audio", "capture.wav",
                        wavData.toRequestBody("audio/wav".toMediaType())
                    )
                    .addFormDataPart("deviceId", deviceId)
                    .build()

                val request = Request.Builder()
                    .url("$serverUrl/api/voice/transcribe")
                    .post(body)
                    .build()

                Log.i(TAG, "Sending ${wavData.size / 1024}KB audio to $serverUrl")
                val response = httpClient.newCall(request).execute()
                val responseBody = response.body?.string()
                if (response.isSuccessful) {
                    Log.i(TAG, "Transcription: $responseBody")
                    // Extract text from {"text":"..."} and broadcast
                    val textMatch = Regex(""""text"\s*:\s*"([^"]+)"""").find(responseBody ?: "")
                    textMatch?.groupValues?.getOrNull(1)?.let { broadcastTranscription(it) }
                } else {
                    Log.w(TAG, "Transcription failed: ${response.code} $responseBody")
                }
                response.close()
            } catch (e: Exception) {
                Log.e(TAG, "Send failed", e)
            }
        }.start()
    }

    private fun connectWebSocket() {
        val wsUrl = serverUrl
            .replace("http://", "ws://")
            .replace("https://", "wss://") + "/ws"

        val request = Request.Builder().url(wsUrl).build()

        wsClient = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "WebSocket connected to $wsUrl")
                // Announce device name — the existing TTS system routes by name
                // via sendToDeviceName, not by channel subscription
                webSocket.send("""{"type":"ws.device-name","deviceName":"$DEVICE_NAME","deviceId":"$deviceId"}""")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    // voice.tts.audio — base64-encoded WAV pushed by the voice-response pipeline
                    if (text.contains("\"voice.tts.audio\"")) {
                        // Extract base64 audio
                        val audioStart = text.indexOf("\"audio\":\"") + 9
                        if (audioStart < 9) return
                        val audioEnd = text.indexOf("\"", audioStart)
                        if (audioEnd <= audioStart) return
                        val audioB64 = text.substring(audioStart, audioEnd)

                        Log.i(TAG, "TTS audio received (${audioB64.length / 1024}KB base64)")
                        broadcastState("tts_playing")
                        playAudio(Base64.decode(audioB64, Base64.DEFAULT))

                        // Also extract text for display
                        val textMatch = Regex(""""text"\s*:\s*"([^"]+)"""").find(text)
                        textMatch?.groupValues?.getOrNull(1)?.let {
                            broadcastTranscription("[Hex] $it")
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "WS message parse failed", e)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "WebSocket failed: ${t.message} — reconnecting in 5s")
                if (running) {
                    Thread.sleep(5000)
                    connectWebSocket()
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "WebSocket closed: $code $reason")
                if (running) {
                    Thread.sleep(5000)
                    connectWebSocket()
                }
            }
        })
    }

    private fun playAudio(wavData: ByteArray) {
        Thread {
            try {
                // Parse WAV header to get format
                if (wavData.size < 44) return@Thread
                val sampleRate = wavData.getIntLE(24)
                val bitsPerSample = wavData.getShortLE(34).toInt()
                val dataSize = wavData.getIntLE(40)

                val encoding = if (bitsPerSample == 16) AudioFormat.ENCODING_PCM_16BIT
                else AudioFormat.ENCODING_PCM_8BIT

                val track = AudioTrack.Builder()
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setSampleRate(sampleRate)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .setEncoding(encoding)
                            .build()
                    )
                    .setBufferSizeInBytes(dataSize)
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build()

                track.write(wavData, 44, dataSize)
                track.play()

                // Wait for playback to complete
                val durationMs = (dataSize.toLong() * 1000) / (sampleRate * bitsPerSample / 8)
                Thread.sleep(durationMs + 100)

                track.stop()
                track.release()
            } catch (e: Exception) {
                Log.e(TAG, "Playback failed", e)
            }
        }.start()
    }

    // --- State broadcasting ---

    private fun broadcastState(state: String) {
        val intent = Intent(ACTION_STATE_CHANGE)
        intent.putExtra("state", state)
        intent.setPackage(packageName)
        sendBroadcast(intent)
    }

    private fun broadcastTranscription(text: String) {
        val intent = Intent(ACTION_TRANSCRIPTION)
        intent.putExtra("text", text)
        intent.setPackage(packageName)
        sendBroadcast(intent)
    }

    // --- Utilities ---

    private fun getOrCreateDeviceId(): String {
        val prefs = getSharedPreferences("sovereign_voice", MODE_PRIVATE)
        var id = prefs.getString("device_id", null)
        if (id == null) {
            id = "voice-android-${Build.MODEL}-${UUID.randomUUID().toString().take(8)}"
            prefs.edit().putString("device_id", id).apply()
            Log.i(TAG, "Generated device ID: $id")
        }
        return id
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Voice Node",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Wake word detection service"
            setShowBadge(false)
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val intent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )

        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Sovereign Voice")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(intent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "SovereignVoice::WakeWordDetection",
        ).apply { acquire() }
    }
}

// Little-endian helpers for WAV parsing and writing
private fun DataOutputStream.writeIntLE(v: Int) {
    write(v and 0xFF)
    write((v shr 8) and 0xFF)
    write((v shr 16) and 0xFF)
    write((v shr 24) and 0xFF)
}

private fun DataOutputStream.writeShortLE(v: Int) {
    write(v and 0xFF)
    write((v shr 8) and 0xFF)
}

private fun ByteArray.getIntLE(offset: Int): Int {
    return (this[offset].toInt() and 0xFF) or
            ((this[offset + 1].toInt() and 0xFF) shl 8) or
            ((this[offset + 2].toInt() and 0xFF) shl 16) or
            ((this[offset + 3].toInt() and 0xFF) shl 24)
}

private fun ByteArray.getShortLE(offset: Int): Short {
    return ((this[offset].toInt() and 0xFF) or
            ((this[offset + 1].toInt() and 0xFF) shl 8)).toShort()
}
