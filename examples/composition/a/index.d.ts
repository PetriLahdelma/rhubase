export interface DialogProps {
  title: string;
  open: boolean;
  onClose: () => void;
}

/** A product dialog whose retained design requires an external portal primitive. */
export declare function Dialog(props: DialogProps): unknown;
