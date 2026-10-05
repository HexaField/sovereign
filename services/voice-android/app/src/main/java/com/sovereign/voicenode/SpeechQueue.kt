package com.sovereign.voicenode

/**
 * Speech queue — the same rules as the web client (tts-queue.ts) and the
 * voice node (tts_queue.py).
 *
 * Whole replies play one after another, never cut off for another. A reply
 * (utterance) arrives as one clip or as streamed chunks; its chunks play in
 * order and the queue waits for late chunks instead of jumping ahead. A short
 * cue sounds between back-to-back replies. An acknowledgement goes ahead of
 * replies still waiting, but never interrupts the one playing.
 *
 * [play] and [cue] block until the sound ends; one worker thread runs them.
 */
class SpeechQueue(
    private val play: (ByteArray) -> Unit,
    private val cue: () -> Unit,
    private val onIdle: () -> Unit = {},
    private val stallMs: Long = 20_000,
    private val cueWithinMs: Long = 3_000,
    private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private class Utterance(val id: String, val priority: Boolean) {
        val clips = ArrayDeque<ByteArray>()
        var done = false
    }

    private val lock = Object()
    private val queue = ArrayList<Utterance>()
    private var current: Utterance? = null
    // Replies already played or given up on: a late chunk must not restart one.
    private val finished = LinkedHashSet<String>()
    private var worker: Thread? = null
    // When speech last finished playing: a reply starting soon after gets the cue.
    private var lastEnded = Long.MIN_VALUE / 2

    fun enqueue(utterance: String, clip: ByteArray, last: Boolean, priority: Boolean = false) {
        synchronized(lock) {
            if (utterance in finished) return
            val u = current?.takeIf { it.id == utterance }
                ?: queue.firstOrNull { it.id == utterance }
                ?: Utterance(utterance, priority).also { created ->
                    // Priority goes ahead of replies still waiting, after earlier priority ones.
                    val at = if (priority) queue.indexOfFirst { !it.priority }.takeIf { it >= 0 } ?: queue.size else queue.size
                    queue.add(at, created)
                }
            if (u.done) return
            u.clips.addLast(clip)
            if (last) u.done = true
            lock.notifyAll()
            if (worker == null) {
                worker = Thread(::run, "tts-playback").apply { isDaemon = true; start() }
            }
        }
    }

    /** Wait until everything queued has played (tests). */
    fun awaitIdle() {
        while (true) (synchronized(lock) { worker } ?: return).join()
    }

    private fun nextClip(u: Utterance): ByteArray? = synchronized(lock) {
        val deadline = clock() + stallMs
        while (u.clips.isEmpty()) {
            if (u.done) return null
            val left = deadline - clock()
            if (left <= 0) return null // stalled: give up on the rest of this reply
            lock.wait(left)
        }
        u.clips.removeFirst()
    }

    private fun run() {
        while (true) {
            val u = synchronized(lock) {
                // onIdle runs under the lock: a worker started by a later enqueue
                // must not have its playback state overwritten by this one.
                if (queue.isEmpty()) {
                    worker = null
                    onIdle()
                    null
                } else queue.removeAt(0).also { current = it }
            } ?: return
            var started = false
            while (true) {
                val clip = nextClip(u) ?: break
                if (!started) {
                    started = true
                    if (clock() - lastEnded < cueWithinMs) cue()
                }
                play(clip)
                lastEnded = clock()
            }
            synchronized(lock) {
                u.done = true
                finished.add(u.id)
                if (finished.size > 200) finished.remove(finished.first())
                current = null
            }
        }
    }
}
