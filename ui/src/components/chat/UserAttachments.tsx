import { useState } from "react";
import { authenticatedURL } from "../../api/client";
import { useT } from "../../i18n/react";
import type { UserImage } from "../../lib/attachments";
import Sheet, { SheetSecondaryButton } from "../mobile/Sheet";
import Button from "../ui/Button";

/**
 * The one picture viewer, shared by a sent bubble and the composer strip.
 *
 * A phone gets the full-height `Sheet` (Escape, Back, scrim, focus in and
 * back) and spends the top inset itself, because a fixed overlay escapes the
 * shell's padding; from `md` up the same sheet is a centred dialog. The close
 * control is visible and named, and every dismissal reaches one `onClose`.
 */
export function ImageViewer({
  image,
  onClose,
}: {
  image: UserImage | null;
  onClose: () => void;
}) {
  const tr = useT();
  return (
    <Sheet
      open={image !== null}
      onClose={onClose}
      title={image?.name}
      dialog
      className="max-md:h-[100dvh] max-md:max-h-[100dvh] max-md:[padding-top:env(safe-area-inset-top)]"
      bodyClassName="flex items-center justify-center"
      footer={
        <SheetSecondaryButton onClick={onClose}>{tr("composer.closeViewer")}</SheetSecondaryButton>
      }
    >
      {image ? (
        <img
          src={authenticatedURL(image.src)}
          alt={image.name}
          className="mx-auto max-h-[min(60dvh,32rem)] w-auto max-w-full object-contain"
        />
      ) : null}
    </Sheet>
  );
}

/**
 * A sent picture, as the control that opens the viewer ("View <file>").
 *
 * A load failure (the upload was deleted, or the path was never an upload)
 * swaps it for the filename chip — never a broken image, and never a button
 * that would open a picture that is not there.
 */
function ImagePreview({ image, onOpen }: { image: UserImage; onOpen: () => void }) {
  const tr = useT();
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        data-testid="user-attachment-chip"
        className="inline-flex max-w-full items-center rounded-lg border-[length:1px] border-[color:var(--kin-hairline)] bg-[var(--kin-fill)] px-2 py-1.5 text-caption text-kin-muted"
      >
        <span className="truncate">{image.name}</span>
      </span>
    );
  }

  return (
    <Button
      variant="quiet"
      onClick={onOpen}
      aria-label={tr("composer.viewImage", { name: image.name })}
      className="h-auto max-w-full rounded-lg p-0 hover:bg-transparent"
    >
      <img
        src={authenticatedURL(image.src)}
        alt={image.name}
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-h-44 max-w-full rounded-lg border-[length:1px] border-[color:var(--kin-hairline)] object-contain"
      />
    </Button>
  );
}

export default function UserAttachments({ images }: { images?: readonly UserImage[] }) {
  const [viewing, setViewing] = useState<UserImage | null>(null);
  if (!images || images.length === 0) return null;
  return (
    <>
      <div data-testid="user-attachments" className="flex max-w-full flex-wrap justify-end gap-2">
        {images.map((image, index) => (
          <ImagePreview
            key={`${image.src}-${index}`}
            image={image}
            onOpen={() => setViewing(image)}
          />
        ))}
      </div>
      <ImageViewer image={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
