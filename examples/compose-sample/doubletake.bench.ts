// The Compose sample's bench: the same marker protocol as the React Native SDK, written by sdk/kotlin.
export default {
  app: { android: 'dev.doubletake.compose' },
  cases: {
    'cold start': {
      launch: { until: 'mark:home' },
      primary: 'launch.ttfd',
      metrics: ['launch.ttid', 'cpu.time', 'memory.peak'],
    },
    scroll: {
      setup: ['launch', { wait: 'mark:home' }],
      run: [{ scroll: 'down', times: 4 }, { sleep: '1s' }],
      primary: 'frames.janky',
      metrics: ['frames.p90', 'cpu.time'],
    },
  },
};
