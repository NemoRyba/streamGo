package main

import (
	"bytes"
	"compress/zlib"
	"encoding/json"
	"image"
	"image/jpeg"
	"log"
	"net/url"
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
	currentDisplay = 0
)

func captureAndEncodeFrame(display int) ([]byte, error) {
	log.Printf("Capturing frame for display %d", display)
	img, err := screenshot.CaptureDisplay(display)
	if err != nil {
		return nil, err
	}

	log.Printf("Captured image size: %dx%d", img.Bounds().Dx(), img.Bounds().Dy())
	if img.Bounds().Dx() > maxWidth {
		img = resize.Resize(maxWidth, 0, img, resize.Lanczos3).(*image.RGBA)
		log.Printf("Resized image to %dx%d", img.Bounds().Dx(), img.Bounds().Dy())
	}

	captureBuffer.Reset()
	if err := jpeg.Encode(captureBuffer, img, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return nil, err
	}
	log.Printf("JPEG encoded size: %d bytes", captureBuffer.Len())

	compressBuffer.Reset()
	zw := zlib.NewWriter(compressBuffer)
	if _, err := zw.Write(captureBuffer.Bytes()); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	log.Printf("Compressed size: %d bytes", compressBuffer.Len())

	return compressBuffer.Bytes(), nil
}

func sendJSONMessage(conn *websocket.Conn, message interface{}) error {
	jsonBytes, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.BinaryMessage, jsonBytes)
}

func sendDisplayCount(conn *websocket.Conn) error {
	displayCount := screenshot.NumActiveDisplays()
	log.Printf("Sending display count: %d", displayCount)
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

	log.Println("Connecting to server...")
	conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		log.Fatal("Failed to connect to server:", err)
	}
	defer conn.Close()
	log.Println("Connected to server")

	// Identify as Go client
	log.Println("Sending Go client identification")
	if err := sendJSONMessage(conn, map[string]string{"type": "goClient"}); err != nil {
		log.Fatal("Failed to identify as Go client:", err)
	}

	// Handle incoming messages
	go func() {
		for {
			_, message, err := conn.ReadMessage()
			if err != nil {
				log.Println("Read error:", err)
				return
			}
			log.Printf("Received message: %s", string(message))

			var msg struct {
				Type    string `json:"type"`
				Display int    `json:"display"`
			}
			if err := json.Unmarshal(message, &msg); err != nil {
				log.Printf("Failed to parse message: %v", err)
				continue
			}

			switch msg.Type {
			case "goClient":
				log.Println("Received goClient acknowledgment from server")
				if err := sendDisplayCount(conn); err != nil {
					log.Println("Failed to send display count:", err)
				}
			case "requestDisplayCount":
				log.Println("Received request for display count")
				if err := sendDisplayCount(conn); err != nil {
					log.Println("Failed to send display count:", err)
				}
			case "selectDisplay":
				currentDisplay = msg.Display
				log.Printf("Switched to display: %d", currentDisplay)
			default:
				log.Printf("Unknown message type: %s", msg.Type)
			}
		}
	}()

	ticker := time.NewTicker(time.Second / fps)
	defer ticker.Stop()

	for range ticker.C {
		frame, err := captureAndEncodeFrame(currentDisplay)
		if err != nil {
			log.Printf("Failed to capture and encode frame: %v", err)
			continue
		}

		log.Printf("Sending frame of size: %d bytes", len(frame))
		if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			log.Println("Failed to send frame:", err)
			return
		}
	}
}
