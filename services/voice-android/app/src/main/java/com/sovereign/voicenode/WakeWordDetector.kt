package com.sovereign.voicenode

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.util.Log
import java.io.File
import java.nio.FloatBuffer

/**
 * Runs the OpenWakeWord ONNX model on 80ms audio frames.
 *
 * OpenWakeWord expects 16kHz mono float32 frames of 1280 samples (80ms).
 * The model produces a confidence score per frame; when it crosses the
 * threshold, the wake word has been detected.
 *
 * The model name depends on which wake phrase the user trained —
 * each Sovereign instance configures its own.
 */
class WakeWordDetector(
    context: Context,
    modelName: String = "wake_word.onnx",
    private val threshold: Float = 0.5f,
) {
    companion object {
        private const val TAG = "WakeWordDetector"
        const val FRAME_SAMPLES = 1280  // 80ms at 16kHz
        const val SAMPLE_RATE = 16000

        /**
         * Check whether a wake word model exists — either bundled in
         * assets or previously downloaded to app storage.
         */
        fun hasModel(context: Context, modelName: String = "wake_word.onnx"): Boolean {
            // Check app-local cache first
            val cached = File(context.filesDir, modelName)
            if (cached.exists() && cached.length() > 0) return true

            // Check bundled assets
            return try {
                context.assets.open(modelName).use { true }
            } catch (_: Exception) {
                false
            }
        }
    }

    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val session: OrtSession

    init {
        val modelBytes = loadModel(context, modelName)
        session = env.createSession(modelBytes)
        Log.i(TAG, "Wake word model loaded: $modelName (inputs=${session.inputNames})")
    }

    private fun loadModel(context: Context, name: String): ByteArray {
        // Prefer app-local cache (downloaded from Sovereign server)
        val cached = File(context.filesDir, name)
        if (cached.exists() && cached.length() > 0) {
            Log.i(TAG, "Loading model from cache: ${cached.absolutePath}")
            return cached.readBytes()
        }

        // Fall back to bundled assets
        Log.i(TAG, "Loading model from assets: $name")
        return context.assets.open(name).use { it.readBytes() }
    }

    /**
     * Process a single 80ms frame of 16kHz mono float32 audio.
     * Returns the detection confidence (0.0 to 1.0).
     */
    fun processFrame(audioFrame: FloatArray): Float {
        require(audioFrame.size == FRAME_SAMPLES) {
            "Expected $FRAME_SAMPLES samples, got ${audioFrame.size}"
        }

        // Shape: [1, FRAME_SAMPLES]
        val inputShape = longArrayOf(1, FRAME_SAMPLES.toLong())
        val inputBuffer = FloatBuffer.wrap(audioFrame)
        val inputTensor = OnnxTensor.createTensor(env, inputBuffer, inputShape)

        val results = session.run(mapOf(session.inputNames.first() to inputTensor))
        val output = results[0].value

        inputTensor.close()
        results.close()

        // Extract scalar confidence
        val score = when (output) {
            is Array<*> -> {
                @Suppress("UNCHECKED_CAST")
                val arr = output as Array<FloatArray>
                arr[0][0]
            }
            is FloatArray -> output[0]
            else -> {
                Log.w(TAG, "Unexpected output type: ${output?.javaClass}")
                0f
            }
        }

        return score
    }

    /**
     * Check whether a frame exceeds the wake word threshold.
     */
    fun detect(audioFrame: FloatArray): Boolean {
        val score = processFrame(audioFrame)
        if (score >= threshold) {
            Log.i(TAG, "Wake word detected! score=%.3f threshold=%.3f".format(score, threshold))
            return true
        }
        return false
    }

    fun close() {
        session.close()
        env.close()
    }
}
