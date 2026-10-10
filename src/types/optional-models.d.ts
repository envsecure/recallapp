/**
 * Minimal ambient declarations for the optional model runtimes.
 *
 * `@huggingface/transformers` and `tesseract.js` are **optional dependencies**
 * so a low-memory machine can install with `--omit=optional` and still run the
 * fake path. They are therefore not guaranteed to be installed, and TypeScript
 * cannot resolve their real types here.
 *
 * The adapters import them dynamically (`await import(...)`) and cast the
 * result through `unknown`, so these declarations only need to describe the
 * shape actually used. If the real packages are installed, their own types take
 * over and these are shadowed.
 */

declare module 'tesseract.js' {
  export interface TesseractWorker {
    recognize: (
      image: string,
    ) => Promise<{ data: { text?: string; confidence?: number; words?: unknown[] } }>;
    terminate: () => Promise<void>;
  }

  export interface WorkerOptions {
    langPath?: string;
    cacheMethod?: 'read' | 'write' | 'refresh' | 'none';
    cachePath?: string;
    gzip?: boolean;
  }

  export function createWorker(
    lang: string | string[],
    oem?: number,
    options?: WorkerOptions,
  ): Promise<TesseractWorker>;
}

declare module '@huggingface/transformers' {
  export interface TransformersEnv {
    /** The critical one: false forbids fetching weights over the network. */
    allowRemoteModels: boolean;
    /** true permits reading weights already present on disk. */
    allowLocalModels: boolean;
    localModelPath?: string;
    backends?: Record<string, unknown>;
  }

  export const env: TransformersEnv;

  export interface PipelineOptions {
    dtype?: 'fp32' | 'fp16' | 'q8' | 'int8' | 'q4' | 'bnb4' | 'auto';
    device?: 'cpu' | 'gpu' | 'wasm' | 'auto';
    progress_callback?: (p: unknown) => void;
  }

  export interface FeatureExtractionOutput {
    data: ArrayLike<number>;
    dims: number[];
  }

  export interface ImageToTextOutput {
    generated_text?: string;
  }

  export type AnyPipeline = (
    input: string,
    options?: Record<string, unknown>,
  ) => Promise<FeatureExtractionOutput | ImageToTextOutput[]>;

  export function pipeline(
    task: 'feature-extraction' | 'image-to-text',
    model: string,
    options?: PipelineOptions,
  ): Promise<AnyPipeline>;
}