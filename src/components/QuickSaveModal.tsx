import React, { useState, useEffect } from 'react';
import { displayTitle, formatMediaDates, getPoster, handleImageError } from '../utils/helpers.ts';
import { SavedItem } from '../core/cinethos-core.ts';
import { useDialogAccessibility } from '../utils/useDialogAccessibility.ts';

interface QuickSaveModalProps {
  item: any | null;
  savedItem?: SavedItem;
  isOpen: boolean;
  onClose: () => void;
  onSave: (
    item: any,
    status: 'watching' | 'watchlist' | 'completed',
    rating: number | ''
  ) => void;
  onRemove: (item: any) => void;
}

export const QuickSaveModal: React.FC<QuickSaveModalProps> = ({
  item,
  savedItem,
  isOpen,
  onClose,
  onSave,
  onRemove,
}) => {
  const [selectedStatus, setSelectedStatus] = useState<'watching' | 'watchlist' | 'completed'>('watchlist');
  const [personalRating, setPersonalRating] = useState<number | ''>('');
  const dialogRef = useDialogAccessibility(isOpen, onClose);

  useEffect(() => {
    if (item && isOpen) {
      setSelectedStatus(savedItem?.status || 'watchlist');
      setPersonalRating(
        savedItem && savedItem.personal_rating !== '' && Number(savedItem.personal_rating) > 0
          ? Number(savedItem.personal_rating)
          : ''
      );
    }
  }, [item, isOpen, savedItem]);

  if (!isOpen || !item) return null;

  const title = displayTitle(item);
  const poster = getPoster(item);
  const dates = formatMediaDates(item, savedItem);
  const kind = item.media_type === 'tv' ? 'Dizi' : 'Film';
  const ratingText = personalRating ? `${personalRating}/10` : 'Puan verilmedi';

  const handleSave = () => {
    const effectiveStatus =
      typeof personalRating === 'number' && personalRating > 0 && selectedStatus === 'watchlist'
        ? 'completed'
        : selectedStatus;
    onSave(item, effectiveStatus, personalRating);
    onClose();
  };

  const handleRemove = () => {
    onRemove(item);
    onClose();
  };

  return (
    <div
      id="quickSaveModal"
      className="modal-wrap open"
      role="presentation"
      aria-hidden="false"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <article
        ref={dialogRef}
        className="modal quick-save-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quickSaveTitle"
        tabIndex={-1}
      >
        <button className="modal-close" type="button" onClick={onClose} aria-label="Kapat">
          <svg className="icon" aria-hidden="true">
            <use href="#icon-close"></use>
          </svg>
        </button>

        <div className="quick-save-content">
          <div className="quick-save-header">
            {poster && (
              <img
                id="quickSavePoster"
                className="quick-save-thumb"
                src={poster}
                alt=""
                referrerPolicy="no-referrer"
                onError={(e) => handleImageError(e, poster, 'w185')}
              />
            )}
            <div className="quick-save-info">
              <div id="quickSaveMeta" className="quick-save-meta tabular-nums">
                <span id="quickSaveBadge" className="quick-save-kind">{kind}</span>
                {dates ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{dates}</span>
                  </>
                ) : null}
                {item.vote_average ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>★ {Number(item.vote_average).toFixed(1)}</span>
                  </>
                ) : null}
              </div>
              <h2 id="quickSaveTitle" className="quick-save-title">
                {title}
              </h2>
            </div>
          </div>

          <div className="quick-save-body">
            <span className="quick-save-label" id="quickStatusLabel">
              İzleme Durumu
            </span>
            <div
              className="quick-status-grid"
              id="quickStatusGrid"
              role="group"
              aria-labelledby="quickStatusLabel"
            >
              <button
                type="button"
                className={`quick-status-opt ${selectedStatus === 'watchlist' ? 'active' : ''}`}
                aria-label="Durum: İzlenecek"
                aria-pressed={selectedStatus === 'watchlist'}
                onClick={() => setSelectedStatus('watchlist')}
              >
                <span className="status-opt-icon" aria-hidden="true">
                  <svg className="icon">
                    <use href="#icon-bookmark"></use>
                  </svg>
                </span>
                <div className="status-opt-text">
                  <strong>İzlenecek</strong>
                  <small>Daha sonra izlemek için listene ekle</small>
                </div>
              </button>

              <button
                type="button"
                className={`quick-status-opt ${selectedStatus === 'watching' ? 'active' : ''}`}
                aria-label="Durum: İzliyorum"
                aria-pressed={selectedStatus === 'watching'}
                onClick={() => setSelectedStatus('watching')}
              >
                <span className="status-opt-icon" aria-hidden="true">
                  <svg className="icon">
                    <use href="#icon-play"></use>
                  </svg>
                </span>
                <div className="status-opt-text">
                  <strong>İzliyorum</strong>
                  <small>Şu anda takip ettiğin yapım</small>
                </div>
              </button>

              <button
                type="button"
                className={`quick-status-opt ${selectedStatus === 'completed' ? 'active' : ''}`}
                aria-label="Durum: Tamamlandı"
                aria-pressed={selectedStatus === 'completed'}
                onClick={() => setSelectedStatus('completed')}
              >
                <span className="status-opt-icon" aria-hidden="true">
                  <svg className="icon">
                    <use href="#icon-check"></use>
                  </svg>
                </span>
                <div className="status-opt-text">
                  <strong>Tamamlandı</strong>
                  <small>İzlemeyi bitirdin</small>
                </div>
              </button>
            </div>

            <div id="quickSaveRatingWrap" className="quick-save-rating-wrap">
              <div className="quick-save-rating-head">
                <span className="quick-save-rating-caption">
                  Kişisel Puanınız (İsteğe bağlı)
                </span>
                <span id="quickRatingScoreText" className="quick-save-rating-score tabular-nums">
                  {ratingText}
                </span>
              </div>
              <div id="quickStarRating" className="stars" role="radiogroup" aria-label="Hızlı puanlama">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((star) => (
                  <button
                    key={star}
                    type="button"
                    className={`star-button quick-star-btn ${
                      personalRating && star <= personalRating ? 'is-selected' : ''
                    }`}
                    onClick={() => {
                      setPersonalRating(star);
                      if (selectedStatus === 'watchlist') {
                        setSelectedStatus('completed');
                      }
                    }}
                  >
                    {star}
                  </button>
                ))}
                <button
                  id="clearQuickRating"
                  className="star-clear"
                  type="button"
                  onClick={() => setPersonalRating('')}
                >
                  Temizle
                </button>
              </div>
            </div>
          </div>

          <div className="quick-save-footer">
            {savedItem && (
              <button
                id="quickSaveRemove"
                className="btn btn-danger"
                type="button"
                onClick={handleRemove}
              >
                Listeden Kaldır
              </button>
            )}
            <button className="btn" type="button" onClick={onClose}>
              İptal
            </button>
            <button
              id="quickSaveSubmit"
              className="btn btn-primary"
              type="button"
              onClick={handleSave}
            >
              {savedItem ? 'Değişiklikleri Kaydet' : 'Kaydet'}
            </button>
          </div>
        </div>
      </article>
    </div>
  );
};
