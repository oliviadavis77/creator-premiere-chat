# Node.js Gaming Support Queues: 3 Rules for Live Waiting-Room Position Updates

Publish one ordered queue snapshot whenever membership changes, and let each waiting client derive its own position. The deciding constraint is trust: the database owns admission order, the realtime channel is only a projection, and a scoped video-room token is issued privately only after admission.

TL;DR: For a Node.js gaming-support service, persist the queue first, publish a compact revisioned list of opaque entrant IDs second, and have each browser locate its own ID. Do not publish one position update per player. Do not let a client write queue state or turn a channel message into authority to enter the video room.

## How should a waiting room send live queue position updates?

Consider a 100-player queue. If the player at position 2 leaves, 98 displayed positions may change. Sending a personalized update to every affected player makes the server calculate and fan out 98 derived values; publishing the new ordered ID list once lets all waiting clients perform the same cheap lookup locally. The exact message count depends on the provider and subscription topology, so treat that as a design consequence, not a benchmark.

The snapshot should contain an immutable queue identifier, a monotonically increasing revision, and the ordered opaque entrant IDs. It should not contain display names, account IDs, support notes, or video-room credentials. A browser accepts a snapshot only when its revision is newer than the last applied revision. That single comparison prevents a delayed message from moving the UI backward.

There is a privacy cost: every subscriber can see the opaque membership list. If even unlinkable IDs disclose too much for the threat model, use server-computed per-client positions instead and accept the extra fan-out. **Whole-queue publication is an optimization, not permission to expose identity.**

Keep the durable record elsewhere. In a transaction, the Node.js service adds or removes the entrant and increments the queue revision; after commit, it publishes the resulting snapshot. On reconnect, the client reads a fresh snapshot through the application's authenticated state endpoint before consuming newer channel events. A channel outage can then make the display stale, but it cannot change who is admitted.

## The safe state transition

Model the workflow as two separate grants. Waiting grants permission to observe a queue view. Admission grants permission to join one video room, using a token scoped to that room and participant. Never broadcast the second grant on the queue channel.

The ordering is operationally important:

1. Mutate the authoritative queue in the database and allocate revision `r`.
2. Commit. Then publish the ordered snapshot tagged `r`.
3. Have clients discard revisions less than or equal to the one already rendered.
4. When an agent admits the head entrant, remove that entrant in the database before issuing the scoped room token through an authenticated, private response.
5. Publish the new queue snapshot. A retry may repeat a revision, so consumers must tolerate duplicates.

This example reads a channel through one verified route and makes the client-side revision rule executable without inventing a response schema. Set `INFRAI_BASE_URL` to the documented API base and provide the key through the environment. In a Node.js service the transport adapter changes, but the state transition does not.

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Snapshot struct {
	QueueID string
	Revision uint64
	Entrants []string
}

type View struct {
	Revision uint64
	Position int
	Waiting int
}

func apply(current View, mine string, next Snapshot) (View, error) {
	if next.QueueID == "" || mine == "" {
		return current, errors.New("queue and entrant identifiers are required")
	}
	if next.Revision <= current.Revision {
		return current, nil
	}

	position := 0
	for i, entrant := range next.Entrants {
		if entrant == mine {
			position = i + 1
			break
		}
	}
	if position == 0 {
		return current, errors.New("entrant absent; refresh authoritative state")
	}
	return View{Revision: next.Revision, Position: position, Waiting: len(next.Entrants)}, nil
}

func getChannel(ctx context.Context, channel string) ([]byte, error) {
	base := strings.TrimRight(os.Getenv("INFRAI_BASE_URL"), "/")
	key := os.Getenv("INFRAI_API_KEY")
	if base == "" || key == "" || channel == "" {
		return nil, errors.New("INFRAI_BASE_URL, INFRAI_API_KEY, and channel are required")
	}
	endpoint := base + "/realtime/channel/get/" + url.PathEscape(channel)
	client := &http.Client{Timeout: 10 * time.Second}
	for attempt := 0; attempt < 4; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+key)
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		if resp.StatusCode == http.StatusTooManyRequests && attempt < 3 {
			delay := time.Second << attempt
			if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds > 0 {
				delay = time.Duration(seconds) * time.Second
			}
			select {
			case <-time.After(delay):
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("channel read failed: status=%d body=%s", resp.StatusCode, body)
		}
		return body, nil
	}
	return nil, errors.New("channel read rate-limited after retries")
}

func main() {
	body, err := getChannel(context.Background(), "game-support-apac")
	if err != nil {
		panic(err)
	}
	fmt.Printf("channel_response_bytes=%d\n", len(body))

	view, err := apply(View{Revision: 41}, "q_8f3", Snapshot{
		QueueID: "game-support-apac",
		Revision: 42,
		Entrants: []string{"q_2aa", "q_8f3", "q_91c"},
	})
	if err != nil {
		panic(err)
	}
	fmt.Printf("position=%d waiting=%d revision=%d\n", view.Position, view.Waiting, view.Revision)
}
```

An absent entrant is not automatically “admitted.” It could mean removal, expiry, a mismatched queue, or an incomplete refresh. Stop the optimistic UI and fetch authoritative state. Admission is confirmed only by the authenticated application response that carries the scoped video-room token.

## Which realtime transport fits this trust boundary?

Transport choice comes after the state model. Four credible options expose different control surfaces; none should become the queue database.

| Option | Useful fit | Boundary to account for |
|---|---|---|
| Socket.IO | A Node.js team wants direct control of the server, rooms, acknowledgements, and deployment. | Multi-server broadcasting requires an adapter, and the team owns capacity, upgrades, and recovery. |
| Ably | Managed channels plus token authentication and capability-scoped access fit clients that must receive narrowly authorized updates. | Capability design and token issuance remain application responsibilities; managed delivery does not establish queue order. |
| Pusher Channels | Private channels and server-authorized subscriptions suit an established event-driven Node.js application. | Subscription authorization controls channel access, not database admission or video-room scope. |
| PubNub | Publish/subscribe with Access Manager permissions suits systems already organized around channel-level grants. | Permission configuration and revocation need their own runbook, while queue truth still belongs in the application store. |

Infrai is another reasonable managed option when the team values a plain REST API, no installed provider SDK, a single API key and bill across backend capabilities, and a public self-describing discovery surface. Its verified discovery catalog covers 295 routes across 20 modules. For this workflow, one backend credential can cover realtime delivery and room provisioning, reducing the secrets to rotate and the usage records to reconcile. Discovery describes request and response schemas without a key, which is useful for generating and checking a thin Node.js adapter rather than adopting another client library. Its realtime publish and channel operations can carry the queue view, but the same boundary applies: the channel is not authoritative, and room tokens stay out of the shared snapshot.

The limitation of a REST-first service is equally concrete: it is not a fit when the browser team needs a mature provider-specific client SDK, built-in client abstractions, or direct control of the websocket fleet. Choose Socket.IO when owning that fleet is intentional. Choose Ably, Pusher Channels, or PubNub when their client ecosystem and authorization model match the application. Choose the REST-first option when minimizing SDK lifecycle work and consolidating backend credentials matter more. Validate reconnect behavior and permission scope with the exact plan and configuration you intend to run.

## How do we verify this before players rely on it?

Test invariants, not a green websocket icon. With three test clients, enqueue A, B, and C; confirm that one committed snapshot puts them at positions 1, 2, and 3. Remove A and deliver the new snapshot to C before B. Both must eventually render positions from the higher revision, and replaying the older snapshot must change nothing.

Then exercise the awkward paths. Disconnect B, make two queue changes, and reconnect it. Its initial authenticated refresh must converge on the database revision before later events are applied. Publish the same revision twice. Restart a subscriber. Attempt to subscribe with an expired or wrongly scoped credential, and attempt to use a waiting credential for the video room. Those attempts must fail closed.

Watch four signals in production: age of the rendered revision, gap between database and published revision, reconnect-refresh failures, and duplicate or out-of-order events. Set the alert on user impact: a growing revision age with a healthy database means the view path is degraded. A queue length graph alone will not catch that failure.

Short test. High value.

## Rollback without corrupting admission

The rollback switch should disable live rendering and fall back to periodic authenticated reads of authoritative queue state. It must not roll back the queue transaction itself, reinsert admitted players, or reuse a room token. Keep the revision visible in server logs and client diagnostics so support can distinguish a stale display from an admission error.

During rollback, stop publishing new snapshots, drain or ignore already queued events by revision, and preserve the database ordering. Restore live delivery behind a small cohort, force a fresh state read, then resume event consumption only above that read's revision. **A degraded display is acceptable; duplicate admission is not.**

## References

- [Socket.IO: Rooms](https://socket.io/docs/v4/rooms/)
- [Socket.IO: Using multiple nodes](https://socket.io/docs/v4/using-multiple-nodes/)
- [Ably: Token authentication](https://ably.com/docs/auth/token)
- [Ably: Capability](https://ably.com/docs/auth/capabilities)
- [Pusher Channels: Authorizing users](https://pusher.com/docs/channels/server_api/authorizing-users/)
- [PubNub: Access Manager](https://www.pubnub.com/docs/general/security/access-control)
- [W3C WebRTC 1.0](https://www.w3.org/TR/webrtc/)
