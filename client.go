package main

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"image"
	"image/jpeg"
	"log"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/kbinani/screenshot"
	"github.com/nfnt/resize"
)

const (
	serverAddr  = "ws://localhost:3000/ws"
	fps         = 30
	maxWidth    = 1280
	jpegQuality = 80
)

var (
	captureBuffer  = &bytes.Buffer{}
	compressBuffer = &bytes.Buffer{}
	activeDisplays = make(map[int]bool)
	displayMutex   sync.Mutex
)

func captureAndEncodeFrame(display int) (string, error) {
	img, err := screenshot.CaptureDisplay(display)
	if err != nil {
		return "", err
	}

	if img.Bounds().Dx() > maxWidth {
		img = resize.Resize(maxWidth, 0, img, resize.Lanczos3).(*image.RGBA)
	}

	captureBuffer.Reset()
	if err := jpeg.Encode(captureBuffer, img, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return "", err
	}

	compressBuffer.Reset()
	zw := zlib.NewWriter(compressBuffer)
	if _, err := zw.Write(captureBuffer.Bytes()); err != nil {
		return "", err
	}
	if err := zw.Close(); err != nil {
		return "", err
	}

	return base64.StdEncoding.EncodeToString(compressBuffer.Bytes()), nil
}

func sendJSONMessage(conn *websocket.Conn, message interface{}) error {
	return conn.WriteJSON(message)
}

func sendDisplayCount(conn *websocket.Conn) error {
	displayCount := screenshot.NumActiveDisplays()
	return sendJSONMessage(conn, map[string]interface{}{
		"type":  "displayCount",
		"count": displayCount,
	})
}

func main() {
	u, err := url.Parse(serverAddr)
	if err != nil {
		log.Fatal("Failed to parse server address:", err)
	}

	conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		log.Fatal("Failed to connect to server:", err)
	}
	defer conn.Close()

	if err := sendJSONMessage(conn, map[string]string{"type": "goClient"}); err != nil {
		log.Fatal("Failed to identify as Go client:", err)
	}

	go func() {
		for {
			var msg struct {
				Type    string `json:"type"`
				Display int    `json:"display"`
			}
			if err := conn.ReadJSON(&msg); err != nil {
				log.Println("Read error:", err)
				return
			}

			switch msg.Type {
			case "goClient":
				if err := sendDisplayCount(conn); err != nil {
					log.Println("Failed to send display count:", err)
				}
			case "requestDisplayCount":
				if err := sendDisplayCount(conn); err != nil {
					log.Println("Failed to send display count:", err)
				}
			case "selectDisplay":
				displayMutex.Lock()
				activeDisplays[msg.Display] = true
				displayMutex.Unlock()
				log.Printf("Display %d selected", msg.Display)
			case "unselectDisplay":
				displayMutex.Lock()
				delete(activeDisplays, msg.Display)
				displayMutex.Unlock()
				log.Printf("Display %d unselected", msg.Display)
			default:
				log.Printf("Unknown message type: %s", msg.Type)
			}
		}
	}()

	ticker := time.NewTicker(time.Second / fps)
	defer ticker.Stop()

	for range ticker.C {
		displayMutex.Lock()
		displays := make([]int, 0, len(activeDisplays))
		for d := range activeDisplays {
			displays = append(displays, d)
		}
		displayMutex.Unlock()

		for _, display := range displays {
			frameData, err := captureAndEncodeFrame(display)
			if err != nil {
				log.Printf("Failed to capture and encode frame for display %d: %v", display, err)
				continue
			}

			if err := sendJSONMessage(conn, map[string]interface{}{
				"type":    "frame",
				"display": display,
				"data":    frameData,
			}); err != nil {
				log.Println("Failed to send frame:", err)
				return
			}
		}
	}
}
