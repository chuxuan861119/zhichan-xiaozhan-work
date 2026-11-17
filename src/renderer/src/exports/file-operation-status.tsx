export function FileOperationStatus({ message }: { message: string }) {
  return (
    <div className="dialog-backdrop file-operation-backdrop">
      <section
        className="file-operation-status"
        role="dialog"
        aria-modal="true"
        aria-label="正在处理文件"
      >
        <span className="file-operation-spinner" aria-hidden="true" />
        <p role="status" aria-live="polite">
          {message}
        </p>
      </section>
    </div>
  );
}
