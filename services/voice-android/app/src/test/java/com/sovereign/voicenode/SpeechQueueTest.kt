package com.sovereign.voicenode

import org.junit.Assert.assertEquals
import org.junit.Test

class SpeechQueueTest {
    private val log = java.util.Collections.synchronizedList(mutableListOf<String>())

    private fun queue(stallMs: Long = 5_000, cueWithinMs: Long = 3_000) = SpeechQueue(
        play = { clip -> log.add(String(clip)); Thread.sleep(20) },
        cue = { log.add("cue") },
        stallMs = stallMs,
        cueWithinMs = cueWithinMs,
    )

    private fun SpeechQueue.add(u: String, clip: String, last: Boolean, priority: Boolean = false) =
        enqueue(u, clip.toByteArray(), last, priority)

    @Test
    fun interleavedRepliesPlayWholeOneAtATimeWithACue() {
        val q = queue()
        q.add("A", "A0", false)
        q.add("B", "B0", false)
        q.add("A", "A1", false)
        q.add("B", "B1", true)
        q.add("A", "A2", true)
        q.awaitIdle()
        assertEquals(listOf("A0", "A1", "A2", "cue", "B0", "B1"), log.toList())
    }

    @Test
    fun waitsForALateChunkInsteadOfJumpingAhead() {
        val q = queue()
        q.add("A", "A0", false)
        q.add("B", "B0", true)
        Thread.sleep(200)
        assertEquals(listOf("A0"), log.toList())
        q.add("A", "A1", true)
        q.awaitIdle()
        assertEquals(listOf("A0", "A1", "cue", "B0"), log.toList())
    }

    @Test
    fun givesUpOnAStalledReplyAndDropsItsLateChunk() {
        val q = queue(stallMs = 100)
        q.add("A", "A0", false)
        q.add("B", "B0", true)
        Thread.sleep(400)
        q.add("A", "A1-late", true)
        q.awaitIdle()
        assertEquals(listOf("A0", "B0"), log.filter { it != "cue" })
    }

    @Test
    fun ackGoesAheadOfWaitingRepliesWithoutInterrupting() {
        val q = queue()
        q.add("A", "A0", true)
        Thread.sleep(10) // A starts playing
        q.add("B", "B0", true)
        q.add("ack", "ack", true, priority = true)
        q.awaitIdle()
        assertEquals(listOf("A0", "cue", "ack", "cue", "B0"), log.toList())
    }

    @Test
    fun idleNeverLandsAfterANewReplyStarts() {
        // A slow onIdle (a broadcast) overlaps a new reply arriving.
        val q = SpeechQueue(
            play = { clip -> log.add(String(clip)) },
            cue = {},
            onIdle = { Thread.sleep(150); log.add("idle") },
            cueWithinMs = 0,
        )
        q.add("A", "A0", true)
        Thread.sleep(50) // A0 played, onIdle under way
        q.add("B", "B0", true)
        Thread.sleep(400)
        q.awaitIdle()
        assertEquals(listOf("A0", "idle", "B0", "idle"), log.toList())
    }

    @Test
    fun noCueAfterAQuietGap() {
        val q = queue(cueWithinMs = 100)
        q.add("A", "A0", true)
        q.awaitIdle()
        Thread.sleep(200)
        q.add("B", "B0", true)
        q.awaitIdle()
        assertEquals(listOf("A0", "B0"), log.toList())
    }
}
