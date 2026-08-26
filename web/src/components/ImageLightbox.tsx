import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { usePortalContainer } from "@/components/ui/portal-container";

interface ImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

/**
 * 普通页面挂到 body；管理 Gate 内挂到其本地容器，以继承 hidden/inert 访问边界。
 */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const { container, blocked } = usePortalContainer();

  useEffect(() => {
    if (blocked) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [blocked, onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `预览图片：${alt}` : "预览图片"}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
        title="关闭"
        aria-label="关闭预览"
      >
        <X className="size-5" />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
        onClick={(event) => event.stopPropagation()}
      />
    </div>,
    container ?? document.body,
  );
}
