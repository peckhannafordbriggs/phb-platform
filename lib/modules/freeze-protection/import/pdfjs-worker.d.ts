// pdfjs-dist ships no types for the worker entry; it is imported only to hand
// its WorkerMessageHandler to the main thread (see pdf.ts).
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
