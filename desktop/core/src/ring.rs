//! A lock-free single-producer single-consumer ring of f32 samples, for the audio threads: the
//! producer (an audio callback) and the consumer (the processing thread or another callback) never
//! block each other and never allocate.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

pub struct Ring {
    buf: UnsafeCell<Box<[f32]>>,
    mask: usize,
    /// Total samples written / read (they only grow; the difference is the fill level).
    head: AtomicUsize,
    tail: AtomicUsize,
    /// Samples the producer had to drop because the ring was full.
    pub overruns: AtomicU64,
    /// Samples the consumer asked for and did not get (see [`Ring::pop_padded`]).
    pub underruns: AtomicU64,
}

// One producer and one consumer, each only touching its own end: see push / pop.
unsafe impl Sync for Ring {}
unsafe impl Send for Ring {}

impl Ring {
    /// A ring of at least `capacity` samples (rounded up to a power of two).
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.next_power_of_two().max(2);
        Ring { buf: UnsafeCell::new(vec![0.0; cap].into_boxed_slice()), mask: cap - 1, head: AtomicUsize::new(0), tail: AtomicUsize::new(0), overruns: AtomicU64::new(0), underruns: AtomicU64::new(0) }
    }

    pub fn capacity(&self) -> usize {
        self.mask + 1
    }

    /// Samples waiting.
    pub fn len(&self) -> usize {
        self.head.load(Ordering::Acquire).wrapping_sub(self.tail.load(Ordering::Acquire))
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Samples the consumer has taken in all (they only grow): a playback position.
    pub fn popped(&self) -> usize {
        self.tail.load(Ordering::Acquire)
    }

    /// Producer side: writes what fits, counts the rest as overruns; returns how many were written.
    pub fn push(&self, data: &[f32]) -> usize {
        let head = self.head.load(Ordering::Relaxed);
        let free = self.capacity() - head.wrapping_sub(self.tail.load(Ordering::Acquire));
        let n = data.len().min(free);
        let buf = unsafe { &mut *self.buf.get() };
        for (i, v) in data[..n].iter().enumerate() {
            buf[head.wrapping_add(i) & self.mask] = *v;
        }
        self.head.store(head.wrapping_add(n), Ordering::Release);
        if n < data.len() {
            self.overruns.fetch_add((data.len() - n) as u64, Ordering::Relaxed);
        }
        n
    }

    /// Consumer side: reads up to `out.len()` samples; returns how many were read.
    pub fn pop(&self, out: &mut [f32]) -> usize {
        let tail = self.tail.load(Ordering::Relaxed);
        let avail = self.head.load(Ordering::Acquire).wrapping_sub(tail);
        let n = out.len().min(avail);
        let buf = unsafe { &*self.buf.get() };
        for (i, o) in out[..n].iter_mut().enumerate() {
            *o = buf[tail.wrapping_add(i) & self.mask];
        }
        self.tail.store(tail.wrapping_add(n), Ordering::Release);
        n
    }

    /// Like [`Ring::pop`], the missing part of `out` filled with silence and counted as underrun.
    pub fn pop_padded(&self, out: &mut [f32]) -> usize {
        let n = self.pop(out);
        if n < out.len() {
            out[n..].fill(0.0);
            self.underruns.fetch_add((out.len() - n) as u64, Ordering::Relaxed);
        }
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn fifo_with_wraparound_and_overrun() {
        let r = Ring::new(8);
        assert_eq!(r.capacity(), 8);
        assert_eq!(r.push(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]), 6);
        let mut out = [0.0; 4];
        assert_eq!(r.pop(&mut out), 4);
        assert_eq!(out, [1.0, 2.0, 3.0, 4.0]);
        assert_eq!(r.push(&[7.0, 8.0, 9.0, 10.0, 11.0, 12.0]), 6); // wraps; 8 fit (2 + 6)
        assert_eq!(r.push(&[13.0]), 0);
        assert_eq!(r.overruns.load(Ordering::Relaxed), 1);
        let mut out = [0.0; 8];
        assert_eq!(r.pop(&mut out), 8);
        assert_eq!(out, [5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0]);
        assert!(r.is_empty());
    }

    #[test]
    fn padded_pop_counts_underruns() {
        let r = Ring::new(8);
        r.push(&[1.0, 2.0]);
        let mut out = [9.0; 5];
        assert_eq!(r.pop_padded(&mut out), 2);
        assert_eq!(out, [1.0, 2.0, 0.0, 0.0, 0.0]);
        assert_eq!(r.underruns.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn two_threads_keep_the_order() {
        let r = Arc::new(Ring::new(1024));
        let p = r.clone();
        let total = 200_000usize;
        let t = std::thread::spawn(move || {
            let mut i = 0usize;
            while i < total {
                let chunk: Vec<f32> = (i..(i + 100).min(total)).map(|v| v as f32).collect();
                // wait for room, as a producer that must not lose samples would (an audio callback just drops them)
                if p.capacity() - p.len() < chunk.len() {
                    std::thread::yield_now();
                    continue;
                }
                assert_eq!(p.push(&chunk), chunk.len());
                i += chunk.len();
            }
        });
        let mut next = 0usize;
        let mut buf = [0f32; 64];
        while next < total {
            let n = r.pop(&mut buf);
            for v in &buf[..n] {
                assert_eq!(*v as usize, next);
                next += 1;
            }
            if n == 0 {
                std::thread::yield_now();
            }
        }
        t.join().unwrap();
        assert_eq!(r.overruns.load(Ordering::Relaxed), 0);
    }
}
