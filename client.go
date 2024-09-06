package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"log"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/kbinani/screenshot"
	"github.com/pion/mediadevices"
	"github.com/pion/webrtc/v3"

	// These are required to register the encoder and screen capture driver
	_ "github.com/pion/mediadevices/pkg/codec/x264"
	_ "github.com/pion/mediadevices/pkg/driver/screen"
)

type Config struct {
	Quality int
	FPS     int
}

type StreamType string

const (
	StreamTypeFrameByFrame StreamType = "frame-by-frame"
	StreamTypeDiff         StreamType = "diff"
	StreamTypeWebRTC       StreamType = "webrtc"
)

type Client struct {
	conn           *websocket.Conn
	config         Config
	streaming      bool
	stopChan       chan struct{}
	mutex          sync.Mutex
	lastFrame      *image.RGBA
	lastFrameMux   sync.Mutex
	diff           bool
	clientID       string
	streamType     StreamType
	peerConnection *webrtc.PeerConnection
	mediaStream    mediadevices.MediaStream
}

var (
	clients    = make(map[string]*Client)
	clientsMux sync.Mutex
)

func main() {
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		enableCors(&w)
		handleConnection(w, r)
	})
	log.Println("Server starting on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func enableCors(w *http.ResponseWriter) {
	(*w).Header().Set("Access-Control-Allow-Origin", "*")
	(*w).Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	(*w).Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func handleConnection(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}

	clientID := r.URL.Query().Get("id")
	log.Printf("New client connected: %s", clientID)

	clientsMux.Lock()
	if existingClient, exists := clients[clientID]; exists {
		log.Printf("Closing existing connection for client %s", clientID)
		existingClient.conn.Close()
		delete(clients, clientID)
	}
	config := Config{Quality: 75, FPS: 10}
	client := &Client{conn: conn, config: config, stopChan: make(chan struct{}), diff: false, clientID: clientID}
	clients[clientID] = client
	clientsMux.Unlock()

	defer func() {
		conn.Close()
		clientsMux.Lock()
		delete(clients, clientID)
		clientsMux.Unlock()
		log.Printf("Client disconnected: %s", clientID)
	}()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Read error for client %s: %v", clientID, err)
			break
		}

		log.Printf("Received message from client %s: %s", clientID, string(message))

		var request map[string]interface{}
		if err := json.Unmarshal(message, &request); err != nil {
			log.Printf("JSON error for client %s: %v", clientID, err)
			continue
		}

		switch request["type"] {
		case "frame":
			display, ok := request["display"].(float64)
			if !ok {
				log.Printf("Invalid display value for frame request from client %s", clientID)
				continue
			}
			sendFrame(clientID, int(display))
		case "startStream":
			display, ok := request["display"].(float64)
			if !ok {
				log.Printf("Invalid display value for stream request from client %s", clientID)
				continue
			}
			client.mutex.Lock()
			if !client.streaming {
				client.streaming = true
				client.stopChan = make(chan struct{})
				go streamDisplay(clientID, int(display))
				log.Printf("Started streaming for client %s", clientID)
			}
			client.mutex.Unlock()
		case "stopStream":
			client.mutex.Lock()
			if client.streaming {
				client.streaming = false
				close(client.stopChan)
				log.Printf("Stopping stream for client %s", clientID)
			}
			client.mutex.Unlock()
		case "displayCount":
			sendDisplayCount(conn)
		case "toggleDiffOnly":
			diffOnly, ok := request["value"].(bool)
			if !ok {
				log.Printf("Invalid diffOnly value from client %s", clientID)
				continue
			}
			clients[clientID].diff = bool(diffOnly)
			log.Printf("Set diffOnly to %t for client %s", diffOnly, clientID)
		case "setQuality":
			quality, ok := request["quality"].(float64)
			if !ok {
				log.Printf("Invalid quality value from client %s", clientID)
				continue
			}
			client.config.Quality = int(quality)
			log.Printf("Set quality to %d for client %s", client.config.Quality, clientID)
		case "setFPS":
			fps, ok := request["fps"].(float64)
			if !ok {
				log.Printf("Invalid FPS value from client %s", clientID)
				continue
			}
			client.config.FPS = int(fps)
			log.Printf("Set FPS to %d for client %s", client.config.FPS, clientID)
		default:
			log.Printf("Unknown message type from client %s: %v", clientID, request["type"])
		}
	}
}

func streamDisplay(clientID string, display int) {
	clientsMux.Lock()
	client, exists := clients[clientID]
	clientsMux.Unlock()
	if !exists {
		log.Printf("Client %s not found for streaming", clientID)
		return
	}

	ticker := time.NewTicker(time.Second / time.Duration(client.config.FPS))
	defer ticker.Stop()

	log.Printf("Starting stream loop for client %s", clientID)
	for {
		select {
		case <-client.stopChan:
			log.Printf("Received stop signal for client %s", clientID)
			return
		case <-ticker.C:
			client.mutex.Lock()
			if !client.streaming {
				client.mutex.Unlock()
				log.Printf("Streaming stopped for client %s", clientID)
				return
			}
			client.mutex.Unlock()
			if err := sendFrame(clientID, display); err != nil {
				log.Printf("Error sending frame to client %s: %v", clientID, err)
				return
			}
		}
	}
}

func sendFrame(clientID string, display int) error {
	clientsMux.Lock()
	client, exists := clients[clientID]
	clientsMux.Unlock()
	if !exists {
		log.Printf("Client %s not found for sending frame", clientID)
		return nil
	}

	img, err := screenshot.CaptureDisplay(display)
	if err != nil {
		log.Printf("Capture error: %v", err)
		return client.conn.WriteJSON(map[string]interface{}{
			"type":  "error",
			"error": "Failed to capture display",
		})
	}

	var diffImg *image.RGBA
	var diff = clients[clientID].diff

	/*if diff {
		client.lastFrameMux.Lock()
		if client.lastFrame != nil {
			diffImg = getDiffImage(client.lastFrame, img)
		}
		client.lastFrame = img
		client.lastFrameMux.Unlock()
	}*/

	var frameToSend *image.RGBA
	if diff {
		blurRadius := 1.5 // Adjust this value to control blur intensity
		frameToSend = applyGaussianBlur(img, blurRadius)
	} else {
		frameToSend = img
	}

	buf := new(bytes.Buffer)
	if err := jpeg.Encode(buf, frameToSend, &jpeg.Options{Quality: client.config.Quality}); err != nil {
		return fmt.Errorf("JPEG encode error: %v", err)
	}

	data := buf.Bytes()
	encoded := base64.StdEncoding.EncodeToString(data)

	return client.conn.WriteJSON(map[string]interface{}{
		"type":    "frame",
		"display": display,
		"data":    encoded,
		"diff":    diff && diffImg != nil,
	})
}

func applyGaussianBlur(img *image.RGBA, radius float64) *image.RGBA {
	bounds := img.Bounds()
	blurred := image.NewRGBA(bounds)

	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			var r, g, b, a float64
			var sum float64

			for ky := -int(radius); ky <= int(radius); ky++ {
				for kx := -int(radius); kx <= int(radius); kx++ {
					ix := x + kx
					iy := y + ky

					if ix >= bounds.Min.X && ix < bounds.Max.X && iy >= bounds.Min.Y && iy < bounds.Max.Y {
						weight := gaussian(float64(kx), float64(ky), radius)
						col := img.RGBAAt(ix, iy)
						r += float64(col.R) * weight
						g += float64(col.G) * weight
						b += float64(col.B) * weight
						a += float64(col.A) * weight
						sum += weight
					}
				}
			}

			blurred.Set(x, y, color.RGBA{
				R: uint8(r / sum),
				G: uint8(g / sum),
				B: uint8(b / sum),
				A: uint8(a / sum),
			})
		}
	}

	return blurred
}

func gaussian(x, y, sigma float64) float64 {
	return math.Exp(-(x*x + y*y) / (2 * sigma * sigma))
}

func getDiffImage(prev, curr *image.RGBA) *image.RGBA {
	bounds := prev.Bounds()
	diff := image.NewRGBA(bounds)
	threshold := uint32(10) // Adjust this value to change sensitivity
	//	changedPixels := 0
	//	totalPixels := bounds.Dx() * bounds.Dy()

	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			r1, g1, b1, _ := prev.At(x, y).RGBA()
			r2, g2, b2, _ := curr.At(x, y).RGBA()

			if abs(int64(r1)-int64(r2)) > int64(threshold) ||
				abs(int64(g1)-int64(g2)) > int64(threshold) ||
				abs(int64(b1)-int64(b2)) > int64(threshold) {
				// Changed pixel: set it to the new color
				diff.Set(x, y, color.RGBA{uint8(r2 >> 8), uint8(g2 >> 8), uint8(b2 >> 8), 255})
			} else {
				// Unchanged pixel: set it to transparent
				diff.Set(x, y, color.RGBA{0, 0, 0, 0})
			}
		}
	}

	//	changePercentage := float64(changedPixels) / float64(totalPixels) * 100
	//	log.Printf("Diff image: %d/%d pixels changed (%.2f%%)", changedPixels, totalPixels, changePercentage)

	return diff
}

func abs(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

func sendDisplayCount(conn *websocket.Conn) {
	count := screenshot.NumActiveDisplays()
	conn.WriteJSON(map[string]interface{}{
		"type":  "displayCount",
		"count": count,
	})
}
