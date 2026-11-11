import { registerRootComponent } from 'expo';
import { start } from 'doubletake/sdk';
import App from './App';

start();
registerRootComponent(App);
