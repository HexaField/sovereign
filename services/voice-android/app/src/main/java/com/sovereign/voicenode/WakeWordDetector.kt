package com.sovereign.voicenode

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.util.Log
import java.nio.FloatBuffer

/**
 * Runs the OpenWakeWord ONNX model on 80ms audio frames.
 *
 * OpenWakeWord expects 16kHz mono float32 frames of 1280 samples (80ms).
 * The model produces a confidence score per frame; when it crosses the
 * threshold, the wake word has been detected.
 */
class WakeWordDetector(
    context: Context,
    private val modelName: String = "hey_hex.onnx",
    private val threshold: Float = 0.5f,
) {
    companion object {
        private const val TAG = "WakeWordDetector"
        const val FRAME_SAMPLES = 1280  // 80ms at 16kHz
        const val SAMPLE_RATE = 16000
    }

    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val session: OrtSession

    init {
        // Load model from assets
        val modelBytes = context.assets.open(modelName).use { it.readBytes() }
        session = env.createSession(modelBytes)
        Log.i(TAG, "Wake word model loaded: $modelName (inputs=${session.inputNames})")
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
