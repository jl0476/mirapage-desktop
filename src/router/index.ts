// Vue Router 配置

import { createRouter, createWebHistory } from 'vue-router';
import Home from '@/views/Home.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: Home,
    },
    {
      path: '/shortcuts',
      name: 'shortcuts',
      component: () => import('@/views/Shortcuts.vue'),
    },
    {
      // v0.1.0-module3.0.7: Library 视图已删,旧链接重定向到 /likes(兼容 dev hot reload / 调试 / 未来 deep-link)
      path: '/library',
      redirect: '/likes',
    },
    {
      path: '/bookmarks',
      name: 'bookmarks',
      component: () => import('@/views/Bookmarks.vue'),
    },
    {
      path: '/likes',
      name: 'likes',
      component: () => import('@/views/Likes.vue'),
    },
    {
      path: '/history',
      name: 'history',
      component: () => import('@/views/History.vue'),
    },
    {
      path: '/accounts',
      name: 'accounts',
      component: () => import('@/views/Accounts.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/Settings.vue'),
    },
    {
      path: '/reader/:bookId',
      name: 'reader',
      component: () => import('@/views/ReaderView.vue'),
    },
  ],
});

export default router;