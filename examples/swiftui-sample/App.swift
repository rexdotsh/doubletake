import SwiftUI

// SLOW=1 at build time (`-D SLOW`) makes the "before" app: 300 ms of main-thread work before the first
// screen, and heavier rows.
@main
struct SampleApp: App {
  init() { Doubletake.start() }
  var body: some Scene { WindowGroup { ContentView() } }
}

func busy(_ ms: Double) {
  let end = Date().addingTimeInterval(ms / 1000)
  var x = 0.0
  while Date() < end { x += (x + 1).squareRoot() }
}

struct ContentView: View {
  @State private var ready = false
  var body: some View {
    Group {
      if ready {
        List(0..<2000, id: \.self) { i in
          Row(index: i)
        }
        .onAppear { DispatchQueue.main.async { Doubletake.mark("home") } }
      } else {
        Color.white
      }
    }
    .task {
      #if SLOW
        busy(300)
      #endif
      ready = true
    }
  }
}

struct Row: View {
  let index: Int
  var body: some View {
    #if SLOW
      let _ = busy(4)
    #endif
    Text("Row \(index)").frame(height: 44)
  }
}
