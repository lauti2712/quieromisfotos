// Service worker de notificaciones (Firebase Cloud Messaging): muestra los avisos de venta con la app cerrada.
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
firebase.initializeApp({
  apiKey: 'AIzaSyD8-421zYevgPvfuS9mvF_6LYE3GdALzLA',
  authDomain: 'quieromisfotos-71629.firebaseapp.com',
  projectId: 'quieromisfotos-71629',
  storageBucket: 'quieromisfotos-71629.firebasestorage.app',
  messagingSenderId: '566210366600',
  appId: '1:566210366600:web:0f11be04fce5a0e66ae33d',
});
firebase.messaging();
