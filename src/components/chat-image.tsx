"use client";
import { Attachment, AttachmentMedia, AttachmentTrigger } from "@/components/ui/attachment";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { imageUrl, thumbnailUrl } from "@/lib/images";
import { Button } from "@/components/ui/button";
import Image from "next/image";
import { Skeleton } from "@/components/ui/skeleton";
import { XIcon } from "lucide-react";
import { reportClient } from "@/lib/client-logging";
import { useState } from "react";

const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 900;

export function ChatImage({ source, alt = "Image from Pocket" }: { source: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = imageUrl(source);

  if (!src) {
    return <span className="image-error">This image source is unavailable.</span>;
  }

  return (
    <Dialog>
      <Attachment className="chat-image" state={failed ? "error" : "done"}>
        <AttachmentMedia className="chat-image-media" variant="image">
          {!loaded && !failed && <Skeleton className="image-placeholder" />}
          {failed ? (
            <span className="image-error">Image unavailable</span>
          ) : (
            <span className="image-fit-stage">
              <Image
                unoptimized
                src={thumbnailUrl(src)}
                alt={alt}
                width={IMAGE_WIDTH}
                height={IMAGE_HEIGHT}
                loading="eager"
                decoding="async"
                referrerPolicy="no-referrer"
                onLoad={() => setLoaded(true)}
                onError={() => {
                  setFailed(true);
                  reportClient("image.failed", { source: src.startsWith("data:") ? "inline image" : src }, "error");
                }}
              />
            </span>
          )}
        </AttachmentMedia>
        {!failed && <DialogTrigger render={<AttachmentTrigger aria-label={`Preview image: ${alt}`} />} />}
      </Attachment>
      <DialogContent className="image-preview" showCloseButton={false}>
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <DialogDescription className="sr-only">Full image preview, scaled to fit your screen.</DialogDescription>
        <div className="image-preview-toolbar">
          <DialogClose render={<Button variant="ghost" size="icon-xl" aria-label="Close image preview" />}>
            <XIcon />
          </DialogClose>
        </div>
        <div className="image-preview-stage">
          <div className="image-fit-stage">
            <Image
              unoptimized
              src={src}
              alt={alt}
              width={IMAGE_WIDTH}
              height={IMAGE_HEIGHT}
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
