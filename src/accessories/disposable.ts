/** A live wrapper owns its state subscription until replaced, removed or shut down. */
export interface DisposableAccessory {
  dispose: () => void
}
