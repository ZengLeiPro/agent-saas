import { createApp } from 'vue';

import App from './App.vue';
import { bootstrap } from './ky.js';

createApp(App).mount('#app');
void bootstrap();
