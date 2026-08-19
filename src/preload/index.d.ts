import type { RykeApi } from './index';

declare global {
  interface Window {
    ryke: RykeApi;
  }
}

export {};
