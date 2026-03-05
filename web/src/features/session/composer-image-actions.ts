import type {
  ClipboardEvent as ReactClipboardEvent,
  Dispatch,
  DragEvent as ReactDragEvent,
  MutableRefObject,
  SetStateAction,
} from "react";
import { uploadImage } from "../../api";
import { dataTransferHasImage, firstImageFile } from "./view-helpers";

type CreateComposerImageActionsDeps = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  activeThreadID: string;
  activeThreadBusy: boolean;
  composerDropActive: boolean;
  composerDragDepthRef: MutableRefObject<number>;

  setUploadingImage: Dispatch<SetStateAction<boolean>>;
  setImageUploadError: Dispatch<SetStateAction<string>>;
  setComposerDropActive: Dispatch<SetStateAction<boolean>>;
  addThreadImagePath: (threadID: string, imagePath: string) => void;
};

export function createComposerImageActions(
  deps: CreateComposerImageActionsDeps,
) {
  const canUpload = () => deps.authPhase === "ready" && deps.token.trim() !== "";

  const onUploadSessionImage = async (
    file: File,
    threadID = deps.activeThreadID,
  ) => {
    if (!canUpload()) return;
    const targetThreadID = threadID.trim();
    if (!targetThreadID) return;
    if (!file.type.toLowerCase().startsWith("image/")) {
      deps.setImageUploadError("Only image files are supported.");
      return;
    }
    deps.setUploadingImage(true);
    deps.setImageUploadError("");
    try {
      const uploaded = await uploadImage(deps.token, file);
      deps.addThreadImagePath(targetThreadID, uploaded.path);
    } catch (error) {
      deps.setImageUploadError(String(error));
    } finally {
      deps.setUploadingImage(false);
    }
  };

  const onComposerPaste = (
    event: ReactClipboardEvent<HTMLTextAreaElement>,
  ) => {
    if (!deps.activeThreadID || deps.activeThreadBusy) return;
    const imageFile = firstImageFile(event.clipboardData?.files);
    if (!imageFile) return;
    event.preventDefault();
    void onUploadSessionImage(imageFile, deps.activeThreadID);
  };

  const onComposerDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!deps.activeThreadID || deps.activeThreadBusy) return;
    if (!dataTransferHasImage(event.dataTransfer)) return;
    event.preventDefault();
    deps.composerDragDepthRef.current += 1;
    deps.setComposerDropActive(true);
  };

  const onComposerDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!deps.activeThreadID || deps.activeThreadBusy) return;
    if (!dataTransferHasImage(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!deps.composerDropActive) {
      deps.setComposerDropActive(true);
    }
  };

  const onComposerDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!deps.composerDropActive) return;
    event.preventDefault();
    deps.composerDragDepthRef.current = Math.max(
      0,
      deps.composerDragDepthRef.current - 1,
    );
    if (deps.composerDragDepthRef.current > 0) return;
    deps.setComposerDropActive(false);
  };

  const onComposerDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!dataTransferHasImage(event.dataTransfer)) return;
    event.preventDefault();
    deps.composerDragDepthRef.current = 0;
    deps.setComposerDropActive(false);
    if (!deps.activeThreadID || deps.activeThreadBusy) return;
    const imageFile = firstImageFile(event.dataTransfer?.files);
    if (!imageFile) return;
    void onUploadSessionImage(imageFile, deps.activeThreadID);
  };

  return {
    onUploadSessionImage,
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
  };
}
