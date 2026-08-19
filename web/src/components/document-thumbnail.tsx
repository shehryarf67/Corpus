'use client'

import Image from 'next/image'
import { useState } from 'react'
import { PagePreview } from '@/components/page-preview'

export function DocumentThumbnail({
  documentId,
  title,
  status,
  thumbnailAvailable,
}: {
  documentId: string
  title: string
  status: string | null
  thumbnailAvailable: boolean
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const isReady = status === 'done'
  const showImage = isReady && thumbnailAvailable && !imageFailed

  return (
    <div className="relative aspect-[3/4] overflow-hidden bg-page">
      {showImage ? (
        <Image
          src={`/api/documents/${encodeURIComponent(documentId)}/thumbnail`}
          alt={`First page of ${title}`}
          fill
          sizes="(min-width: 1024px) 288px, (min-width: 640px) 50vw, 100vw"
          className="object-contain object-top"
          unoptimized
          onError={() => setImageFailed(true)}
        />
      ) : (
        <PagePreview seed={documentId} variant={isReady ? 'page' : 'blank'} />
      )}

      {!isReady && (
        <div className="absolute inset-0 grid place-items-center">
          <span className="font-mono text-[10.5px] tracking-[0.06em] text-graphite-dim">
            {status === 'failed' ? 'no preview' : 'processing...'}
          </span>
        </div>
      )}
    </div>
  )
}
