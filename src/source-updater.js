/**
 * @file source-updater.js
 */
import videojs from 'video.js';
import logger from './util/logger';
import noop from './util/noop';
import { parseMimeTypes } from './util/codecs';
import { buffered } from './util/buffer';

const actions = {
  appendBuffer: (bytes) => (type, updater) => {
    const {
      [`${type}Buffer`]: sourceBuffer
    } = updater;

    sourceBuffer.appendBuffer(bytes);
  },
  remove: (start, end) => (type, updater) => {
    const {
      [`${type}Buffer`]: sourceBuffer
    } = updater;

    sourceBuffer.remove(start, end);
  },
  timestampOffset: (offset) => (type, updater) => {
    const {
      [`${type}Buffer`]: sourceBuffer
    } = updater;

    sourceBuffer.timestampOffset = offset;
  },
  callback: (callback) => (type, updater) => {
    callback();
  }
};

const updating = (type, updater) => {
  const {
    [`${type}Buffer`]: sourceBuffer,
    queue: {
      [type]: {
        pending
      }
    }
  } = updater;

  return (sourceBuffer && sourceBuffer.updating) || pending;
};

const shiftQueue = (type, updater) => {
  const {
    queue: {
      [type]: queue
    },
    started_
  } = updater;

  if (updating(type, updater) || !queue.actions.length || !started_) {
    return;
  }

  const action = queue.actions.shift();

  queue.pending = action[1];
  action[0](type, updater);
};

const pushQueue = (type, updater, action) => {
  const {
    queue: { [type]: queue }
  } = updater;

  queue.actions.push(action);
  shiftQueue(type, updater);
};

const onUpdateend = (type, updater) => () => {
  const {
    queue: { [type]: queue }
  } = updater;

  if (!queue.pending) {
    shiftQueue(type, updater);
  }

  if (!queue.pending) {
    // nothing in the queue
    return;
  }

  const doneFn = queue.pending.doneFn;

  queue.pending = null;

  if (doneFn) {
    doneFn();
  }

  shiftQueue(type, updater);
};

/**
 * A queue of callbacks to be serialized and applied when a
 * MediaSource and its associated SourceBuffers are not in the
 * updating state. It is used by the segment loader to update the
 * underlying SourceBuffers when new data is loaded, for instance.
 *
 * @class SourceUpdater
 * @param {MediaSource} mediaSource the MediaSource to create the SourceBuffer from
 * @param {String} mimeType the desired MIME type of the underlying SourceBuffer
 */
export default class SourceUpdater extends videojs.EventTarget {
  constructor(mediaSource) {
    super();
    this.mediaSource = mediaSource;
    this.logger_ = logger('SourceUpdater');
    // initial timestamp offset is 0
    this.audioTimestampOffset_ = 0;
    this.videoTimestampOffset_ = 0;
    this.queue = {
      audio: {
        actions: [],
        doneFn: null
      },
      video: {
        actions: [],
        doneFn: null
      }
    };
  }

  ready() {
    return !!(this.audioBuffer || this.videoBuffer);
  }

  createSourceBuffers(codecs) {
    if (this.ready()) {
      // already created them before
      return;
    }

    if (this.mediaSource.readyState === 'closed') {
      this.mediaSource.addEventListener(
        'sourceopen', this.createSourceBuffers.bind(this, codecs));
      return;
    }

    if (codecs.audio) {
      // default
      let audioCodec = 'mp4a.40.2';

      if (codecs.audio.mimeType) {
        let parsed = parseMimeTypes(codecs.audio.mimeType);

        if (parsed && parsed.audio) {
          audioCodec = parsed.audio;
        }
      }

      this.audioBuffer = this.mediaSource.addSourceBuffer(
        `audio/mp4;codecs="${audioCodec}"`);
      this.logger_(`created SourceBuffer audio/mp4;codecs="${audioCodec}`);
    }

    if (codecs.video) {
      // default
      let videoCodec = 'avc1.4d400d';

      if (codecs.video.mimeType) {
        let parsed = parseMimeTypes(codecs.video.mimeType);

        if (parsed && parsed.video) {
          videoCodec = parsed.video;
        }
      }

      this.videoBuffer = this.mediaSource.addSourceBuffer(
        `video/mp4;codecs="${videoCodec}"`);
      this.logger_(`created SourceBuffer video/mp4;codecs="${videoCodec}"`);
    }

    this.trigger('ready');

    this.start_();
  }

  start_() {
    this.started_ = true;

    if (this.audioBuffer) {
      this.onAudioUpdateEnd_ = onUpdateend('audio', this);
      this.audioBuffer.addEventListener('updateend', this.onAudioUpdateEnd_);
      shiftQueue('audio', this);
    }
    if (this.videoBuffer) {
      this.onVideoUpdateEnd_ = onUpdateend('video', this);
      this.videoBuffer.addEventListener('updateend', this.onVideoUpdateEnd_);
      shiftQueue('video', this);
    }
  }

  /**
   * Queue an update to append an ArrayBuffer.
   *
   * @param {MediaObject} object containing audioBytes and/or videoBytes
   * @param {Function} done the function to call when done
   * @see http://www.w3.org/TR/media-source/#widl-SourceBuffer-appendBuffer-void-ArrayBuffer-data
   */
  appendBuffer(type, bytes, doneFn) {
    this.processedAppend_ = true;
    pushQueue(type, this, [
      actions.appendBuffer(bytes),
      { doneFn, name: 'appendBuffer' }
    ]);
  }

  audioBuffered() {
    return this.audioBuffer && this.audioBuffer.buffered;
  }

  videoBuffered() {
    return this.videoBuffer && this.videoBuffer.buffered;
  }

  buffered() {
    return buffered(this.videoBuffer, this.audioBuffer, this.audioDisabled_);
  }

  /**
   * Queue an update to remove a time range from the buffer.
   *
   * @param {Number} start where to start the removal
   * @param {Number} end where to end the removal
   * @see http://www.w3.org/TR/media-source/#widl-SourceBuffer-remove-void-double-start-unrestricted-double-end
   */
  removeAudio(start, end) {
    if (!this.audioBuffer) {
      return;
    }

    pushQueue('audio', this, [
      actions.remove(start, end),
      { doneFn: noop, name: 'remove' }
    ]);
  }

  /**
   * Queue an update to remove a time range from the buffer.
   *
   * @param {Number} start where to start the removal
   * @param {Number} end where to end the removal
   * @see http://www.w3.org/TR/media-source/#widl-SourceBuffer-remove-void-double-start-unrestricted-double-end
   */
  removeVideo(start, end) {
    if (!this.videoBuffer) {
      return;
    }

    pushQueue('video', this, [
      actions.remove(start, end),
      { doneFn: noop, name: 'remove' }
    ]);
  }

  /**
   * Whether the underlying sourceBuffer is updating or not
   *
   * @return {Boolean} the updating status of the SourceBuffer
   */
  updating() {
    if (this.audioBuffer && this.audioBuffer.updating) {
      return true;
    }
    if (this.videoBuffer && this.videoBuffer.updating) {
      return true;
    }
    if (this.pendingCallback_) {
      return true;
    }
    return false;
  }

  /**
   * Set/get the timestampoffset on the audio SourceBuffer
   *
   * @return {Number} the timestamp offset
   */
  audioTimestampOffset(offset) {
    if (typeof offset !== 'undefined' &&
        this.audioBuffer &&
        // updateend doesn't fire when timestamp offset isn't different
        this.audioBuffer.timestampOffset !== offset) {
      pushQueue('audio', this, [
        actions.timestampOffset(offset),
        null
      ]);
      this.audioTimestampOffset_ = offset;
    }
    return this.audioTimestampOffset_;
  }

  /**
   * Set/get the timestampoffset on the video SourceBuffer
   *
   * @return {Number} the timestamp offset
   */
  videoTimestampOffset(offset) {
    if (typeof offset !== 'undefined' &&
        this.videoBuffer &&
        // updateend doesn't fire when timestamp offset isn't different
        this.videoBuffer.timestampOffset !== offset) {
      pushQueue('video', this, [
        actions.timestampOffset(offset),
        null
      ]);
      this.videoTimestampOffset_ = offset;
    }
    return this.videoTimestampOffset_;
  }

  audioQueueCallback(callback) {
    if (this.audioBuffer) {
      pushQueue('audio', this, [
        actions.callback(callback),
        null
      ]);
    }
  }

  videoQueueCallback(callback) {
    if (this.videoBuffer) {
      pushQueue('video', this, [
        actions.callback(callback),
        null
      ]);
    }
  }
  /**
   * dispose of the source updater and the underlying sourceBuffer
   */
  dispose() {
    // Abort then remove each source buffer. Removing is important for idempotency.
    if (this.audioBuffer) {
      if (this.mediaSource.readyState === 'open') {
        this.audioBuffer.abort();
      }
      this.audioBuffer.removeEventListener('updateend', this.onAudioUpdateEnd_);
      this.audioBuffer = null;
    }
    if (this.videoBuffer) {
      if (this.mediaSource.readyState === 'open') {
        this.videoBuffer.abort();
      }
      this.videoBuffer.removeEventListener('updateend', this.onVideoUpdateEnd_);
      this.videoBuffer = null;
    }
  }
}
