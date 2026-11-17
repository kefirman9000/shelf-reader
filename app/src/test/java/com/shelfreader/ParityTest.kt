package com.shelfreader

import org.junit.Test
import java.io.File

/** Writes app/build/parity/kotlin.json for desktop/test/parity.test.js (see ParityDump). */
class ParityTest {
    @Test(timeout = 60_000)
    fun writeParityDump() {
        val root = listOf(File(".."), File(".")).first { File(it, "tools/parity-cases.txt").exists() }
        File(root, "app/build/parity/kotlin.json").also { it.parentFile.mkdirs() }.writeText(ParityDump.dump(root))
    }
}
