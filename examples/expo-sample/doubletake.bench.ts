// The sample app's bench: `doubletake bench examples/expo-sample/doubletake.bench.ts --base before.app --head after.app`
export default {
  app: { ios: 'dev.doubletake.sample', android: 'dev.doubletake.sample' },
  cases: {
    'cold start': {
      launch: { until: 'mark:home' },
      primary: 'launch.ttfd',
      metrics: ['cpu.time', 'memory.peak'],
    },
    scroll: {
      setup: ['launch', { wait: 'mark:home' }],
      run: [{ scroll: 'down', times: 4 }],
      primary: 'js.stall',
      metrics: ['js.frames.dropped', 'cpu.time'],
    },
    idle: {
      setup: ['launch', { wait: 'mark:home' }],
      idle: '10s',
      primary: 'cpu.idle',
      metrics: ['net.requests'],
    },
  },
};
