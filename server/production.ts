// npm start always applies production safeguards, even when NODE_ENV was omitted.
process.env.NODE_ENV = 'production';
await import('./index.ts');

export {};
