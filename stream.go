package main

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"log"
	"net/http"
	"strconv"
	"sync"

	"github.com/kbinani/screenshot"
)

const (
	port = 8080
)

var (
	jpegQuality = 1 // Adjust JPEG quality to balance speed and image quality
	bufPool     = sync.Pool{
		New: func() interface{} {
			return new(bytes.Buffer)
		},
	}
	mu sync.Mutex
)

func captureScreen(bounds image.Rectangle, frameCh chan<- []byte, stopCh <-chan struct{}) {
	for {
		select {
		case <-stopCh:
			close(frameCh)
			return
		default:

			img, err := screenshot.CaptureRect(bounds)
			if err != nil {
				log.Printf("Failed to capture screenshot: %v", err)
				continue
			}

			buf := bufPool.Get().(*bytes.Buffer)
			buf.Reset()

			mu.Lock()
			err = jpeg.Encode(buf, img, &jpeg.Options{Quality: jpegQuality})
			mu.Unlock()

			if err != nil {
				log.Printf("Failed to encode JPEG: %v", err)
				bufPool.Put(buf)
				continue
			}

			frameCh <- buf.Bytes()
			bufPool.Put(buf)

		}
	}
}

func streamHandler(bounds image.Rectangle) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/stream" {
			w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=frame")

			stopCh := make(chan struct{})
			frameCh := make(chan []byte, 1)

			go captureScreen(bounds, frameCh, stopCh)

			defer func() {
				close(stopCh)
				for range frameCh {
				} // Drain frame channel
			}()

			for frame := range frameCh {
				w.Write([]byte("--frame\r\nContent-Type: image/jpeg\r\n\r\n"))
				w.Write(frame)
				w.Write([]byte("\r\n"))

				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
			}
			return
		}
		http.NotFound(w, r)
	}
}

func controlHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		r.ParseForm()
		if val, ok := r.Form["jpegQuality"]; ok {
			if newJpegQuality, err := strconv.Atoi(val[0]); err == nil {
				mu.Lock()
				jpegQuality = newJpegQuality
				mu.Unlock()

				// Log the updated duration
				log.Printf("Updated newJpegQuality to: %v ... ", newJpegQuality)
			}
		}
	}
}

func main() {
	bounds := screenshot.GetDisplayBounds(1)

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			controlHandler(w, r)
			return
		}

		http.ServeFile(w, r, "control.html")
	})

	http.HandleFunc("/stream", streamHandler(bounds))

	fmt.Printf("Started streaming. Open http://localhost:%d/ in your browser to watch and control.\n", port)
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", port), nil))
}
