import pkg from '../package.json' with { type: 'json' };

const [command] = process.argv.slice(2);
if (command === '--version' || command === '-v') process.stdout.write(`${pkg.version}\n`);
else process.stdout.write('doubletake: A/B performance for React Native apps\n');
