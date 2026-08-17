package com.sovereign.voicenode

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.util.Log
import java.io.File
import java.nio.FloatBuffer

/**
 * Full OpenWakeWord inference pipeline on Android.
 *
 * OpenWakeWord uses a 3-stage ONNX pipeline:
 *   1. melspectrogram.onnx  — raw 16kHz mono float32 → mel spectrogram features
 *   2. embedding_model.onnx — mel features → 96-dim embeddings
 *   3. wake_word.onnx       — 16 stacked embeddings → [0..1] confidence
 *
 * Each 80ms frame (1280 samples at 16kHz) produces one embedding.
 * The wake word model consumes a sliding window of 16 embeddings (~1.28s).
 */
class WakeWordDetector(
    context: Context,
    private val threshold: Float = 0.5f,
) {
    companion object {
        private const val TAG = "WakeWordDetector"
        const val FRAME_SAMPLES = 1280  // 80ms at 16kHz
        const val SAMPLE_RATE = 16000
        private const val EMBEDDING_DIM = 96
        private const val WINDOW_SIZE = 16   // frames of embeddings the wake model consumes
        private const val MEL_BANDS = 32
        private const val MEL_FRAMES = 76    // mel frames the embedding model expects

        /** All three ONNX model files needed for the pipeline. */
        val MODEL_FILES = listOf("melspectrogram.onnx", "embedding_model.onnx", "wake_word.onnx")

        /**
         * Check whether all required models exist in app storage.
         */
        fun hasModel(context: Context): Boolean {
            return MODEL_FILES.all { name ->
                val f = File(context.filesDir, name)
                f.exists() && f.length() > 0
            }
        }
    }

    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val melSession: OrtSession
    private val embeddingSession: OrtSession
    private val wakeSession: OrtSession

    // Sliding window of recent embeddings
    private val embeddingWindow = ArrayDeque<FloatArray>(WINDOW_SIZE)

    // Accumulate mel frames across calls (the embedding model needs 76 frames)
    private val melAccumulator = ArrayDeque<FloatArray>()

    init {
        melSession = env.createSession(loadModel(context, "melspectrogram.onnx"))
        embeddingSession = env.createSession(loadModel(context, "embedding_model.onnx"))
        wakeSession = env.createSession(loadModel(context, "wake_word.onnx"))
        Log.i(TAG, "Wake word pipeline loaded (mel→embedding→wake)")
        Log.i(TAG, "  mel inputs: ${melSession.inputNames}, outputs: ${melSession.outputNames}")
        Log.i(TAG, "  emb inputs: ${embeddingSession.inputNames}, outputs: ${embeddingSession.outputNames}")
        Log.i(TAG, "  wake inputs: ${wakeSession.inputNames}, outputs: ${wakeSession.outputNames}")
    }

    private fun loadModel(context: Context, name: String): ByteArray {
        val cached = File(context.filesDir, name)
        if (cached.exists() && cached.length() > 0) {
            Log.i(TAG, "Loading model from cache: ${cached.absolutePath}")
            return cached.readBytes()
        }
        Log.i(TAG, "Loading model from assets: $name")
        return context.assets.open(name).use { it.readBytes() }
    }

    /**
     * Process one 80ms frame (1280 float32 samples at 16kHz).
     * Returns true when the wake word confidence exceeds the threshold.
     *
     * Internally this:
     *   1. Runs the mel spectrogram model on the raw audio
     *   2. Accumulates mel frames until 76 are available
     *   3. Runs the embedding model on [76, 32, 1] mel features
     *   4. Adds the 96-dim embedding to a sliding window of 16
     *   5. Runs the wake word model on [1, 16, 96] embeddings
     */
    fun detect(audioFrame: FloatArray): Boolean {
        require(audioFrame.size == FRAME_SAMPLES) {
            "Expected $FRAME_SAMPLES samples, got ${audioFrame.size}"
        }

        // --- Stage 1: melspectrogram ---
        val melFrames = runMelSpectrogram(audioFrame)
        for (frame in melFrames) {
            melAccumulator.addLast(frame)
        }

        // Need at least MEL_FRAMES accumulated to produce an embedding
        if (melAccumulator.size < MEL_FRAMES) return false

        // --- Stage 2: embedding ---
        // Take the most recent MEL_FRAMES
        while (melAccumulator.size > MEL_FRAMES) {
            melAccumulator.removeFirst()
        }
        val embedding = runEmbedding()

        // Add to sliding window
        embeddingWindow.addLast(embedding)
        while (embeddingWindow.size > WINDOW_SIZE) {
            embeddingWindow.removeFirst()
        }

        // Need a full window to run wake word detection
        if (embeddingWindow.size < WINDOW_SIZE) return false

        // --- Stage 3: wake word ---
        val score = runWakeWord()
        if (score >= threshold) {
            Log.i(TAG, "Wake word detected! score=%.3f threshold=%.3f".format(score, threshold))
            // Clear the window to avoid re-triggering on the same utterance
            embeddingWindow.clear()
            melAccumulator.clear()
            return true
        }
        return false
    }

    /**
     * Same as detect() but returns the raw score instead of a boolean.
     * Returns -1f if not enough data accumulated yet.
     */
    fun detectScore(audioFrame: FloatArray): Float {
        require(audioFrame.size == FRAME_SAMPLES) {
            "Expected $FRAME_SAMPLES samples, got ${audioFrame.size}"
        }

        val melFrames = runMelSpectrogram(audioFrame)
        for (frame in melFrames) {
            melAccumulator.addLast(frame)
        }

        if (melAccumulator.size < MEL_FRAMES) return -1f

        while (melAccumulator.size > MEL_FRAMES) {
            melAccumulator.removeFirst()
        }
        val embedding = runEmbedding()

        embeddingWindow.addLast(embedding)
        while (embeddingWindow.size > WINDOW_SIZE) {
            embeddingWindow.removeFirst()
        }

        if (embeddingWindow.size < WINDOW_SIZE) return -1f

        val score = runWakeWord()
        if (score >= threshold) {
            Log.i(TAG, "Wake word detected! score=%.3f threshold=%.3f".format(score, threshold))
            embeddingWindow.clear()
            melAccumulator.clear()
        }
        return score
    }

    /**
     * Run the melspectrogram model on raw audio.
     * Input: [1, FRAME_SAMPLES] float32
     * Output: [time, 1, ?, 32] — extract the mel frames (each is 32 bands)
     */
    private fun runMelSpectrogram(audio: FloatArray): List<FloatArray> {
        val inputShape = longArrayOf(1, audio.size.toLong())
        val inputTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(audio), inputShape)

        val results = melSession.run(mapOf(melSession.inputNames.first() to inputTensor))
        val output = results[0].value

        inputTensor.close()

        val frames = mutableListOf<FloatArray>()
        try {
            // Output shape: [time, 1, ?, 32] — typically [1, 1, 1, 32] per 80ms frame
            // but can vary. We flatten and extract 32-band mel frames.
            @Suppress("UNCHECKED_CAST")
            when (output) {
                is Array<*> -> {
                    // Nested array — walk the dimensions
                    extractMelFrames(output, frames)
                }
                is FloatArray -> {
                    // Flat — chunk into 32-band frames
                    for (i in output.indices step MEL_BANDS) {
                        if (i + MEL_BANDS <= output.size) {
                            frames.add(output.copyOfRange(i, i + MEL_BANDS))
                        }
                    }
                }
            }
        } finally {
            results.close()
        }

        return frames
    }

    @Suppress("UNCHECKED_CAST")
    private fun extractMelFrames(arr: Any?, frames: MutableList<FloatArray>) {
        when (arr) {
            is FloatArray -> {
                // Leaf — this should have 32 values
                if (arr.size == MEL_BANDS) {
                    frames.add(arr.copyOf())
                } else {
                    // Chunk into 32-band segments
                    for (i in arr.indices step MEL_BANDS) {
                        if (i + MEL_BANDS <= arr.size) {
                            frames.add(arr.copyOfRange(i, i + MEL_BANDS))
                        }
                    }
                }
            }
            is Array<*> -> {
                for (element in arr) {
                    extractMelFrames(element, frames)
                }
            }
        }
    }

    /**
     * Run the embedding model on accumulated mel frames.
     * Input: [1, 76, 32, 1]
     * Output: [1, 1, 1, 96] → extract 96-dim embedding
     */
    private fun runEmbedding(): FloatArray {
        // Build [1, 76, 32, 1] tensor from melAccumulator
        val data = FloatArray(MEL_FRAMES * MEL_BANDS)
        melAccumulator.forEachIndexed { i, frame ->
            System.arraycopy(frame, 0, data, i * MEL_BANDS, MEL_BANDS)
        }

        val inputShape = longArrayOf(1, MEL_FRAMES.toLong(), MEL_BANDS.toLong(), 1)
        val inputTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(data), inputShape)

        val results = embeddingSession.run(mapOf(embeddingSession.inputNames.first() to inputTensor))
        val output = results[0].value

        inputTensor.close()

        val embedding = FloatArray(EMBEDDING_DIM)
        try {
            @Suppress("UNCHECKED_CAST")
            when (output) {
                is Array<*> -> {
                    // [1, 1, 1, 96] — drill to the float array
                    val flat = flattenToFloatArray(output)
                    System.arraycopy(flat, 0, embedding, 0, minOf(flat.size, EMBEDDING_DIM))
                }
                is FloatArray -> {
                    System.arraycopy(output, 0, embedding, 0, minOf(output.size, EMBEDDING_DIM))
                }
            }
        } finally {
            results.close()
        }

        return embedding
    }

    @Suppress("UNCHECKED_CAST")
    private fun flattenToFloatArray(arr: Any?): FloatArray {
        val result = mutableListOf<Float>()
        when (arr) {
            is FloatArray -> result.addAll(arr.toList())
            is Array<*> -> {
                for (element in arr) {
                    result.addAll(flattenToFloatArray(element).toList())
                }
            }
            is Float -> result.add(arr)
        }
        return result.toFloatArray()
    }

    /**
     * Run the wake word model on the embedding window.
     * Input: [1, 16, 96]
     * Output: [1, 1] → confidence score
     */
    private fun runWakeWord(): Float {
        val data = FloatArray(WINDOW_SIZE * EMBEDDING_DIM)
        embeddingWindow.forEachIndexed { i, emb ->
            System.arraycopy(emb, 0, data, i * EMBEDDING_DIM, EMBEDDING_DIM)
        }

        val inputShape = longArrayOf(1, WINDOW_SIZE.toLong(), EMBEDDING_DIM.toLong())
        val inputTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(data), inputShape)

        val results = wakeSession.run(mapOf(wakeSession.inputNames.first() to inputTensor))
        val output = results[0].value

        inputTensor.close()

        val score = when (output) {
            is Array<*> -> {
                @Suppress("UNCHECKED_CAST")
                val arr = output as Array<FloatArray>
                arr[0][0]
            }
            is FloatArray -> output[0]
            else -> {
                Log.w(TAG, "Unexpected wake output type: ${output?.javaClass}")
                0f
            }
        }

        results.close()
        return score
    }

    fun close() {
        melSession.close()
        embeddingSession.close()
        wakeSession.close()
        env.close()
    }
}
