package main

import (
	"bytes"
	"compress/zlib"
	"crypto/tls"
	"encoding/base64"
	"image"
	"image/draw"
	"image/jpeg"
	"log"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/kbinani/screenshot"
	"github.com/nfnt/resize"
)

const (
	serverAddr        = "wss://localhost:3000/ws"
	maxWidth          = 2400
	previewWidth      = 1280
	jpegQuality       = 80
	reconnectInterval = 5 * time.Second
)

var (
	captureBuffer        = &bytes.Buffer{}
	compressBuffer       = &bytes.Buffer{}
	displayMutex         sync.Mutex
	userConnections      = make(map[string]*websocket.Conn)
	userConnectionsMutex sync.Mutex
	isConnected          bool
	connectionMutex      sync.Mutex
)

type frameRequest struct {
	display   int
	userID    string
	isPreview bool
	respond   chan<- string
}

func captureAndEncodeFrame(display int, isPreview bool) (string, error) {
	img, err := screenshot.CaptureDisplay(display)
	if err != nil {
		return "", err
	}

	var resizedImg image.Image
	if isPreview {
		resizedImg = resize.Resize(previewWidth, 0, img, resize.Lanczos3)
	} else if img.Bounds().Dx() > maxWidth {
		resizedImg = resize.Resize(maxWidth, 0, img, resize.Lanczos3)
	} else {
		resizedImg = img
	}

	var rgbaImg *image.RGBA
	if rgba, ok := resizedImg.(*image.RGBA); ok {
		rgbaImg = rgba
	} else {
		bounds := resizedImg.Bounds()
		rgbaImg = image.NewRGBA(bounds)
		draw.Draw(rgbaImg, bounds, resizedImg, bounds.Min, draw.Src)
	}

	captureBuffer.Reset()
	if err := jpeg.Encode(captureBuffer, rgbaImg, &jpeg.Options{Quality: jpegQuality}); err != nil {
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
	log.Printf("Sending display count: %d", displayCount)
	return sendJSONMessage(conn, map[string]interface{}{
		"type":  "displayCount",
		"count": displayCount,
	})
}

func runClient(done chan struct{}) {
	u, err := url.Parse(serverAddr)
	if err != nil {
		log.Println("Failed to parse server address:", err)
		return
	}

	tlsConfig := &tls.Config{
		InsecureSkipVerify: true, // For testing only, remove in production
	}
	dialer := websocket.Dialer{
		TLSClientConfig: tlsConfig,
	}

	for {
		connectionMutex.Lock()
		if isConnected {
			connectionMutex.Unlock()
			time.Sleep(reconnectInterval)
			continue
		}
		isConnected = true
		connectionMutex.Unlock()

		log.Println("Attempting to connect to server...")
		conn, _, err := dialer.Dial(u.String(), nil)
		if err != nil {
			log.Println("Failed to connect to server:", err)
			connectionMutex.Lock()
			isConnected = false
			connectionMutex.Unlock()
			select {
			case <-done:
				return
			case <-time.After(reconnectInterval):
				continue
			}
		}

		log.Println("Connected to server")

		if err := sendJSONMessage(conn, map[string]string{"type": "goClient"}); err != nil {
			log.Println("Failed to identify as Go client:", err)
			conn.Close()
			connectionMutex.Lock()
			isConnected = false
			connectionMutex.Unlock()
			continue
		}

		log.Println("Identified as Go client")

		if err := sendDisplayCount(conn); err != nil {
			log.Println("Failed to send initial display count:", err)
		}

		frameRequests := make(chan frameRequest)
		connClosed := make(chan struct{})

		go handleServerMessages(conn, frameRequests, connClosed)
		go handleFrameRequests(frameRequests, connClosed)

		select {
		case <-connClosed:
			log.Println("Connection closed. Attempting to reconnect...")
			connectionMutex.Lock()
			isConnected = false
			connectionMutex.Unlock()
			time.Sleep(reconnectInterval)
		case <-done:
			log.Println("Received shutdown signal")
			conn.Close()
			return
		}
	}
}

func handleServerMessages(conn *websocket.Conn, frameRequests chan<- frameRequest, connClosed chan<- struct{}) {
	defer close(connClosed)

	for {
		var msg map[string]interface{}
		if err := conn.ReadJSON(&msg); err != nil {
			log.Println("Read error:", err)
			return
		}

		log.Printf("Received message: %+v", msg)

		switch msg["type"].(string) {
		case "requestDisplayCount":
			if err := sendDisplayCount(conn); err != nil {
				log.Println("Failed to send display count:", err)
			}
		case "requestFrame":
			display := int(msg["display"].(float64))
			userID := msg["userID"].(string)
			isPreview := msg["isPreview"].(bool)
			respChan := make(chan string)
			frameRequests <- frameRequest{display: display, userID: userID, isPreview: isPreview, respond: respChan}
			frameData := <-respChan
			if frameData != "" {
				if err := sendJSONMessage(conn, map[string]interface{}{
					"type":    "frame",
					"display": display,
					"userID":  userID,
					"data":    frameData,
				}); err != nil {
					log.Println("Failed to send frame:", err)
				}
			}
		case "directConnect":
			browserEndpoint := msg["browserEndpoint"].(string)
			go handleDirectConnection(browserEndpoint)
		default:
			log.Printf("Unknown message type: %s", msg["type"])
		}
	}
}

func handleFrameRequests(frameRequests <-chan frameRequest, connClosed <-chan struct{}) {
	for {
		select {
		case req := <-frameRequests:
			frameData, err := captureAndEncodeFrame(req.display, req.isPreview)
			if err != nil {
				log.Printf("Failed to capture and encode frame for display %d: %v", req.display, err)
				req.respond <- ""
				continue
			}

			log.Printf("Captured frame for display %d, user %s, size: %d bytes", req.display, req.userID, len(frameData))
			req.respond <- frameData
		case <-connClosed:
			return
		}
	}
}

func handleDirectConnection(browserEndpoint string) {
	u, err := url.Parse(browserEndpoint)
	if err != nil {
		log.Println("Failed to parse browser endpoint:", err)
		return
	}

	conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		log.Println("Failed to connect to browser:", err)
		return
	}
	defer conn.Close()

	log.Println("Connected directly to browser")

	for {
		var msg map[string]interface{}
		if err := conn.ReadJSON(&msg); err != nil {
			log.Println("Read error from browser:", err)
			return
		}

		switch msg["type"].(string) {
		case "requestFrame":
			display := int(msg["display"].(float64))
			isPreview := msg["isPreview"].(bool)
			frameData, err := captureAndEncodeFrame(display, isPreview)
			if err != nil {
				log.Printf("Failed to capture frame for browser: %v", err)
				continue
			}
			if err := sendJSONMessage(conn, map[string]interface{}{
				"type":    "frame",
				"display": display,
				"data":    frameData,
			}); err != nil {
				log.Println("Failed to send frame to browser:", err)
			}
		default:
			log.Printf("Unknown message type from browser: %s", msg["type"])
		}
	}
}

func main() {
	done := make(chan struct{})
	go runClient(done)

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	sig := <-sigChan
	log.Printf("Received signal: %v. Initiating shutdown...", sig)

	close(done)

	time.Sleep(2 * time.Second)
	log.Println("Client shut down gracefully")
}
