package dev.doubletake.sample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.doubletake.Doubletake

fun busy(ms: Long) {
  val end = System.nanoTime() + ms * 1_000_000
  var x = 0.0
  while (System.nanoTime() < end) x += Math.sqrt(x + 1)
}

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    Doubletake.start()
    setContent { Home() }
  }
}

@Composable
fun Home() {
  var ready by remember { mutableStateOf(false) }
  LaunchedEffect(Unit) {
    if (BuildConfig.SLOW) busy(300)
    ready = true
  }
  if (!ready) {
    Box(Modifier.fillMaxSize().background(Color.White))
    return
  }
  LaunchedEffect(Unit) {
    withFrameNanos {}
    Doubletake.mark("home")
  }
  LazyColumn(Modifier.fillMaxSize().background(Color.White)) {
    items(2000) { i -> Row(i) }
  }
}

@Composable
fun Row(index: Int) {
  if (BuildConfig.SLOW) busy(4)
  Box(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 20.dp), contentAlignment = Alignment.CenterStart) {
    Text("Row $index")
  }
}
