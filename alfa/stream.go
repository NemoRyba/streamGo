package main

import (
	"bytes"
	"crypto/subtle"
	"fmt"
	"image"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/chai2010/webp"
	"github.com/kbinani/screenshot"
	"golang.org/x/time/rate"
)

const (
	port            = 8080
	maxWorkers      = 4
	frameChanBuffer = 10
)

var (
	quality    = 75 // WebP quality
	bufPool    = sync.Pool{New: func() interface{} { return new(bytes.Buffer) }}
	mu         sync.Mutex
	limiter    = rate.NewLimiter(rate.Every(time.Second), 60) // 60 requests per second
	workerPool chan struct{}
	auth       = struct{ username, password string }{"admin", "password"}
)

func init() {
	workerPool = make(chan struct{}, maxWorkers)
	for i := 0; i < maxWorkers; i++ {
		workerPool <- struct{}{}
	}
}

func captureAndEncodeFrame(bounds image.Rectangle) ([]byte, error) {
	<-workerPool
	defer func() { workerPool <- struct{}{} }()

	img, err := screenshot.CaptureRect(bounds)
	if err != nil {
		return nil, fmt.Errorf("failed to capture screenshot: %v", err)
	}

	buf := bufPool.Get().(*bytes.Buffer)
	buf.Reset()
	defer bufPool.Put(buf)

	mu.Lock()
	webp.encode
	err = webp.Encode(buf, img, &webp.Options{Lossless: false, Quality: float32(quality)})
	mu.Unlock()

	if err != nil {
		return nil, fmt.Errorf("failed to encode WebP: %v", err)
	}

	return buf.Bytes(), nil
}

func streamHandler(bounds image.Rectangle) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !limiter.Allow() {
			http.Error(w, "Too many requests", http.StatusTooManyRequests)
			return
		}

		w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=frame")

		frameCh := make(chan []byte, frameChanBuffer)
		stopCh := make(chan struct{})

		go func() {
			defer close(frameCh)
			for {
				select {
				case <-stopCh:
					return
				default:
					frame, err := captureAndEncodeFrame(bounds)
					if err != nil {
						log.Printf("Frame capture error: %v", err)
						continue
					}
					select {
					case frameCh <- frame:
					default:
						// Skip frame if channel is full
					}
				}
			}
		}()

		defer close(stopCh)

		for frame := range frameCh {
			_, err := w.Write([]byte("--frame\r\nContent-Type: image/webp\r\n\r\n"))
			if err != nil {
				return
			}
			_, err = w.Write(frame)
			if err != nil {
				return
			}
			_, err = w.Write([]byte("\r\n"))
			if err != nil {
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
	}
}

func controlHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if err := r.ParseForm(); err != nil {
		http.Error(w, "Failed to parse form", http.StatusBadRequest)
		return
	}

	if val, ok := r.Form["quality"]; ok {
		if newQuality, err := strconv.Atoi(val[0]); err == nil && newQuality >= 0 && newQuality <= 100 {
			mu.Lock()
			quality = newQuality
			mu.Unlock()
			log.Printf("Updated quality to: %v", newQuality)
		} else {
			http.Error(w, "Invalid quality value", http.StatusBadRequest)
			return
		}
	}

	w.WriteHeader(http.StatusOK)
}

func basicAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || subtle.ConstantTimeCompare([]byte(username), []byte(auth.username)) != 1 || subtle.ConstantTimeCompare([]byte(password), []byte(auth.password)) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="restricted", charset="UTF-8"`)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	}
}

func main() {
	bounds := screenshot.GetDisplayBounds(0)

	http.HandleFunc("/", basicAuth(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			controlHandler(w, r)
			return
		}
		http.ServeFile(w, r, "control.html")
	}))

	http.HandleFunc("/stream", basicAuth(streamHandler(bounds)))

	fmt.Printf("Started streaming. Open https://localhost:%d/ in your browser to watch and control.\n", port)
	log.Fatal(http.ListenAndServeTLS(fmt.Sprintf(":%d", port), "server.crt", "server.key", nil))
}
