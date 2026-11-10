import type { RefObject } from "react";

export interface FileInputsProps {
  boardFileRef: RefObject<HTMLInputElement | null>;
  imageRef: RefObject<HTMLInputElement | null>;
  onBoardFile: (file: File) => void;
  onImages: (files: File[]) => void;
}

// Hidden pickers that the menu and the toolbar open.
export function FileInputs({ boardFileRef, imageRef, onBoardFile, onImages }: FileInputsProps) {
  return (
    <>
      <input
        ref={boardFileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const [file] = event.target.files!; // a file input always has a list
          if (file) onBoardFile(file);
          event.target.value = "";
        }}
      />

      <input
        ref={imageRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,image/heic,image/heif"
        multiple
        hidden
        onChange={(event) => {
          onImages([...event.target.files!]);
          event.target.value = "";
        }}
      />
    </>
  );
}
