import { useState } from "react";
import { authenticatedURL } from "../../api/client";
import type { UserImage } from "../../lib/attachments";

/**
 * The pictures a user message carried, drawn in its bubble.
 *
 * A thumbnail is not a control: it opens nothing and needs no 44px target.
 * A load failure (the upload was deleted, or the path was never an upload)
 * swaps that one image for its filename chip — never a broken-image icon.
 */
function ImagePreview({ image }: { image: UserImage }) {
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
    <img
      src={authenticatedURL(image.src)}
      alt={image.name}
      loading="lazy"
      onError={() => setFailed(true)}
      className="max-h-44 max-w-full rounded-lg border-[length:1px] border-[color:var(--kin-hairline)] object-contain"
    />
  );
}

export default function UserAttachments({ images }: { images?: readonly UserImage[] }) {
  if (!images || images.length === 0) return null;
  return (
    <div data-testid="user-attachments" className="flex max-w-full flex-wrap justify-end gap-2">
      {images.map((image, index) => (
        <ImagePreview key={`${image.src}-${index}`} image={image} />
      ))}
    </div>
  );
}
