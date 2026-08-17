package com.sovereign.voicenode

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.util.Log
import java.io.File
import java.nio.FloatBuffer
import kotlin.math.min

/**
 * Full OpenWakeWord inference pipeline on Android.
 *
 * Matches the Python OpenWakeWord AudioFeatures preprocessing exactly:
 *   1. melspectrogram.onnx  — int16-scale audio → mel features, transformed with x/10+2
 *   2. embedding_model.onnx — [1,76,32,1] mel window → 96-dim embedding
 *   3. wake_word.onnx       — [1,16,96] embedding window → [0..1] confidence
 *
 * Key details from Python source:
 *   - Mel model expects float32 values in int16 RANGE (-32768..32767), not -1..1
 *   - Mel output gets transformed: x/10 + 2
 *   - Raw audio buffer persists (10s history) — mel runs on n_samples + 480 overlap
 *   - Each 1280-sample chunk produces 8 mel frames
 *   - Mel buffer initialises with ones (76×32)
 *   - Embedding runs on sliding window of 76 mel frames
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
        private const val WINDOW_SIZE = 16   // embedding frames the wake model consumes
        private const val MEL_BANDS = 32
        private const val MEL_FRAMES = 76    // mel frames the embedding model expects
        private const val MEL_CONTEXT_OVERLAP = 480  // 160*3 extra samples for mel context
        private const val RAW_BUFFER_MAX = SAMPLE_RATE * 10  // 10s of raw audio history

        val MODEL_FILES = listOf("melspectrogram.onnx", "embedding_model.onnx", "wake_word.onnx")

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

    // Raw audio ring buffer (int16-scale float32 values), matching Python's deque(maxlen=sr*10)
    private val rawBuffer = FloatArray(RAW_BUFFER_MAX)
    private var rawBufferLen = 0

    // Mel spectrogram buffer — initialised with ones like Python
    private val melBuffer = ArrayList<FloatArray>(970)  // ~10s max
    private val melBufferMaxLen = 10 * 97  // 97 frames per second at 16kHz

    // Embedding / feature buffer
    private val featureBuffer = ArrayList<FloatArray>(120)
    private val featureBufferMaxLen = 120  // ~10s of embeddings

    // Accumulation counter matching Python's accumulated_samples
    private var accumulatedSamples = 0

    init {
        melSession = env.createSession(loadModel(context, "melspectrogram.onnx"))
        embeddingSession = env.createSession(loadModel(context, "embedding_model.onnx"))
        wakeSession = env.createSession(loadModel(context, "wake_word.onnx"))

        // Initialise mel buffer with ones (76×32), matching Python
        for (i in 0 until MEL_FRAMES) {
            melBuffer.add(FloatArray(MEL_BANDS) { 1f })
        }

        Log.i(TAG, "Wake word pipeline loaded (mel→embedding→wake)")
    }

    private fun loadModel(context: Context, name: String): ByteArray {
        val cached = File(context.filesDir, name)
        if (cached.exists() && cached.length() > 0) {
            return cached.readBytes()
        }
        return context.assets.open(name).use { it.readBytes() }
    }

    /**
     * Process one 80ms frame of float32 audio (-1..1 range from AudioRecord).
     * Returns the raw wake word score, or -1f if not enough data accumulated.
     */
    fun detectScore(audioFrame: FloatArray): Float {
        require(audioFrame.size == FRAME_SAMPLES) {
            "Expected $FRAME_SAMPLES samples, got ${audioFrame.size}"
        }

        // Convert float32 (-1..1) to int16-scale float32 (-32768..32767)
        // OpenWakeWord expects int16 values cast to float32
        val int16Audio = FloatArray(audioFrame.size) { i ->
            (audioFrame[i] * 32767f).coerceIn(-32768f, 32767f)
        }

        // Buffer the raw audio
        bufferRawData(int16Audio)
        accumulatedSamples += int16Audio.size

        // Only process when we have a full 1280-sample chunk
        if (accumulatedSamples < FRAME_SAMPLES) return -1f

        // --- Stage 1: Mel spectrogram ---
        // Feed n_samples + 480 overlap to mel model (matching Python's -n_samples-160*3)
        val melInputLen = accumulatedSamples + MEL_CONTEXT_OVERLAP
        val available = rawBufferLen
        val actualLen = min(melInputLen, available)
        if (actualLen < 400) {
            accumulatedSamples = 0
            return -1f
        }

        // Extract the tail of the raw buffer
        val melInput = FloatArray(actualLen)
        val startIdx = rawBufferLen - actualLen
        System.arraycopy(rawBuffer, startIdx, melInput, 0, actualLen)

        val newMelFrames = runMelSpectrogram(melInput)
        for (frame in newMelFrames) {
            melBuffer.add(frame)
        }
        // Trim mel buffer to max length
        while (melBuffer.size > melBufferMaxLen) {
            melBuffer.removeAt(0)
        }

        // --- Stage 2: Embeddings ---
        // Produce one embedding per 1280-sample chunk, using sliding mel window
        // Each chunk = 8 mel frames. Process from oldest to newest.
        val numChunks = accumulatedSamples / FRAME_SAMPLES
        for (i in numChunks - 1 downTo 0) {
            val ndx = if (i == 0) melBuffer.size else melBuffer.size - 8 * i
            val startMel = ndx - MEL_FRAMES
            if (startMel < 0 || ndx > melBuffer.size) continue

            val embedding = runEmbedding(startMel, ndx)
            featureBuffer.add(embedding)
        }
        // Trim feature buffer
        while (featureBuffer.size > featureBufferMaxLen) {
            featureBuffer.removeAt(0)
        }

        // Reset accumulation counter
        accumulatedSamples = 0

        // --- Stage 3: Wake word ---
        if (featureBuffer.size < WINDOW_SIZE) return -1f

        val score = runWakeWord()
        if (score >= threshold) {
            Log.i(TAG, "Wake word detected! score=%.3f threshold=%.3f".format(score, threshold))
            featureBuffer.clear()
            // Re-init mel buffer with ones
            melBuffer.clear()
            for (j in 0 until MEL_FRAMES) {
                melBuffer.add(FloatArray(MEL_BANDS) { 1f })
            }
        }
        return score
    }

    /**
     * Boolean convenience wrapper around detectScore.
     */
    fun detect(audioFrame: FloatArray): Boolean {
        val score = detectScore(audioFrame)
        return score >= threshold
    }

    // --- Raw audio buffer (ring buffer) ---

    private fun bufferRawData(audio: FloatArray) {
        val spaceLeft = RAW_BUFFER_MAX - rawBufferLen
        if (audio.size <= spaceLeft) {
            System.arraycopy(audio, 0, rawBuffer, rawBufferLen, audio.size)
            rawBufferLen += audio.size
        } else {
            // Shift buffer left to make room
            val shift = audio.size - spaceLeft
            System.arraycopy(rawBuffer, shift, rawBuffer, 0, rawBufferLen - shift)
            rawBufferLen -= shift
            System.arraycopy(audio, 0, rawBuffer, rawBufferLen, audio.size)
            rawBufferLen += audio.size
        }
    }

    // --- Stage 1: Mel spectrogram ---

    private fun runMelSpectrogram(audio: FloatArray): List<FloatArray> {
        val inputShape = longArrayOf(1, audio.size.toLong())
        val inputTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(audio), inputShape)

        val results = melSession.run(mapOf(melSession.inputNames.first() to inputTensor))
        val output = results[0].value
        inputTensor.close()

        val frames = mutableListOf<FloatArray>()
        try {
            // Output: [time, 1, ?, 32] — flatten and chunk into 32-band frames
            val flat = flattenToFloatArray(output)
            for (i in flat.indices step MEL_BANDS) {
                if (i + MEL_BANDS <= flat.size) {
                    // Apply OpenWakeWord's mel transform: x/10 + 2
                    val frame = FloatArray(MEL_BANDS) { j -> flat[i + j] / 10f + 2f }
                    frames.add(frame)
                }
            }
        } finally {
            results.close()
        }
        return frames
    }

    // --- Stage 2: Embedding ---

    private fun runEmbedding(startMel: Int, endMel: Int): FloatArray {
        // Build [1, 76, 32, 1] tensor from mel buffer slice
        val data = FloatArray(MEL_FRAMES * MEL_BANDS)
        for (i in startMel until endMel) {
            val frame = melBuffer[i]
            System.arraycopy(frame, 0, data, (i - startMel) * MEL_BANDS, MEL_BANDS)
        }

        val inputShape = longArrayOf(1, MEL_FRAMES.toLong(), MEL_BANDS.toLong(), 1)
        val inputTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(data), inputShape)

        val results = embeddingSession.run(mapOf(embeddingSession.inputNames.first() to inputTensor))
        val output = results[0].value
        inputTensor.close()

        val flat = flattenToFloatArray(output)
        val embedding = FloatArray(EMBEDDING_DIM)
        System.arraycopy(flat, 0, embedding, 0, min(flat.size, EMBEDDING_DIM))

        results.close()
        return embedding
    }

    // --- Stage 3: Wake word ---

    private fun runWakeWord(): Float {
        // Use the last WINDOW_SIZE embeddings
        val startIdx = featureBuffer.size - WINDOW_SIZE
        val data = FloatArray(WINDOW_SIZE * EMBEDDING_DIM)
        for (i in 0 until WINDOW_SIZE) {
            val emb = featureBuffer[startIdx + i]
            System.arraycopy(emb, 0, data, i * EMBEDDING_DIM, EMBEDDING_DIM)
        }

        val inputShape = longArrayOf(1, WINDOW_SIZE.toLong(), EMBEDDING_DIM.toLong())
        val inputTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(data), inputShape)

        val results = wakeSession.run(mapOf(wakeSession.inputNames.first() to inputTensor))
        val output = results[0].value
        inputTensor.close()

        val flat = flattenToFloatArray(output)
        val score = if (flat.isNotEmpty()) flat[0] else 0f

        results.close()
        return score
    }

    // --- Utilities ---

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

    fun close() {
        melSession.close()
        embeddingSession.close()
        wakeSession.close()
        env.close()
    }
}
