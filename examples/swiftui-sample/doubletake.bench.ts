// The SwiftUI sample's bench: the same marker protocol as the React Native SDK, written by sdk/swift.
export default {
  app: { ios: 'dev.doubletake.native' },
  cases: {
    'cold start': { launch: { until: 'mark:home' }, primary: 'launch.ttfd', metrics: ['cpu.time', 'memory.peak'] },
  },
};
