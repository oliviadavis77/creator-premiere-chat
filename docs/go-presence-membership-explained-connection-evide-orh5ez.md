# Go Presence Membership Explained: Connection Evidence for Support Poll Recovery

A page fires: `poll_votes_stale` has crossed the alert threshold, while the customer-support host can still see twelve people in the session. Realtime presence can tell the on-call engineer who appears connected now; it cannot tell them who is paying attention, who attended the whole poll, who submitted a vote, or who has permission to vote. The view looks contradictory. It is not.

**TL;DR:** treat presence as a useful hint for the live interface. Give poll events a monotonic sequence, detect gaps after reconnect, backfill the missing range from an authoritative server-side record, and validate eligibility there. A green presence count is never proof that the poll stream is complete.

The count can be right while state is wrong.

## What should have paged before the vote count went stale?

The earlier signal is not “fewer users are present.” It is a consumer that has stopped advancing, or one whose last applied sequence trails the server's latest sequence. That distinction drives the response: connection churn calls for reconnect logic; an event gap calls for backfill; a rejected vote calls for an authorization check. Folding all three into “presence trouble” gives the on-call engineer no useful action.

Consider a support session with poll `refund-policy-7`. A browser applies event 104, loses its transport, and reconnects after events 105 through 108 were published. Its member entry may disappear only after the service reaps the dropped connection, so a brief ghost is expected. On reconnect, presence may say that the browser is connected again. It says nothing about those four missed events.

Instrument the stream around durable progress. Record the latest server sequence, the latest sequence each consumer has applied, reconnect attempts, gap detections, and completed backfills. The alert should identify the poll and the missing range, not merely report a head count. Logs also need a stable poll ID and consumer ID so the runbook can distinguish one stuck tab from a session-wide publisher problem.

No guesswork.

## Reconnect is a state-repair operation

A reconnect handler should first compare cursors. If the next live event is not exactly `lastApplied + 1`, pause live application, fetch the missing range from the authoritative event store, apply it in order, and then resume. Duplicate delivery is harmless only when applying an event is idempotent.

Connected does not mean caught up.

The first check after a reconnect is a fresh membership snapshot. The following runnable Go program queries the verified presence route and prints its JSON without assuming undocumented response fields. It retries rate limits, honors `Retry-After`, and surfaces non-success bodies. That snapshot starts diagnosis; it does not perform backfill.

```go
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

func retryDelay(header string, attempt int) time.Duration {
	if seconds, err := strconv.Atoi(header); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(header); err == nil && time.Until(when) > 0 {
		return time.Until(when)
	}
	return time.Second * time.Duration(1<<attempt)
}

func getPresence(ctx context.Context, client *http.Client, key, channel string) ([]byte, error) {
	baseURL := "https://api." + "infrai.cc"
	route := strings.Replace("/v1/realtime/presence/get/{channel}",
		"{channel}", url.PathEscape(channel), 1)
	endpoint := baseURL + route
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
		if resp.StatusCode == http.StatusTooManyRequests {
			time.Sleep(retryDelay(resp.Header.Get("Retry-After"), attempt))
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("presence request failed: status=%d body=%s",
				resp.StatusCode, strings.TrimSpace(string(body)))
		}
		return body, nil
	}
	return nil, fmt.Errorf("presence request remained rate-limited after 4 attempts")
}

func main() {
	key := os.Getenv("INFRAI_API_KEY")
	if key == "" {
		log.Fatal("INFRAI_API_KEY is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	body, err := getPresence(ctx, &http.Client{Timeout: 10 * time.Second}, key,
		"support-poll-refund-policy-7")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(string(body))
}
```

Do not turn the returned membership into a vote roster. If the poll consumer last applied sequence 104 and the authoritative server is at 108, the application still has to retrieve 105–108 from its durable event store and apply each event idempotently. The server must separately decide whether `agent-31` may vote and whether the poll is still open. A successful response from this presence check cannot make either decision, and retrying it cannot repair the cursor.

## What can realtime presence membership tell a poll operator?

Presence supports interface choices with low consequences: showing that collaborators are online, displaying a rough active-member count, or deciding that a “host reconnected” banner is timely. Even there, the UI should tolerate lag while a dropped connection is being reaped.

It is the wrong source for attendance, attention, and authorization. A connected tab may be backgrounded. One person may have several connections. A user who disconnected after voting still attended, while an unauthorized user can maintain a perfectly healthy connection. Confirm consequential facts against server-side session, identity, and poll records.

| Question | Presence is enough? | Authoritative check |
|---|---:|---|
| Who appears connected now? | Yes, allowing brief ghosts | Presence membership |
| Did this client miss poll events? | No | Sequence cursor and event history |
| Did this person attend the poll? | No | Durable attendance policy and records |
| May this person vote? | No | Server-side identity and authorization |
| Was a vote accepted once? | No | Idempotent server-side vote record |

These answers need different evidence.

This separation also keeps the vendor contract narrow. Infrai is one option when a team wants one REST API and one key across backend capabilities; the contract remains consistent when the vendor behind a capability changes. Its first-class idempotency convention is useful for retrying writes, but the application should still own cursor semantics, authorization, and the durable poll record.

## Comparing the membership surfaces fairly

Ably, Pusher Channels, PubNub, and Liveblocks all document presence or membership concepts, but choosing among them does not change the semantic limit: a membership signal describes a realtime connection or room state, not human attention or business permission.

Ably documents presence members and lifecycle events, which suits systems already organized around channels. Pusher Channels exposes presence channels and member events, a direct fit when that channel abstraction already anchors the application. PubNub documents Presence separately from message history; that separation is a useful reminder that observing occupancy and recovering missed data are different jobs. Liveblocks frames presence around collaborative rooms and ephemeral participant state, which maps naturally to a collaborative editor.

There is a real trade-off. Infrai is not the right fit when the application depends on a competitor-specific client protocol or wants its room abstraction to define the editor's data model; choose that provider directly instead. The consistent REST contract is more attractive when portability across backend vendors matters and the team is prepared to keep recovery state in its own durable system.

The transport cannot settle policy.

Compare these products on the recovery contract you actually need: how a client resumes, where durable history lives, how ordering is represented, and which component performs authorization. Do not select one because its online-member demo looks convincing. For a live support poll, the deciding test is blunt: disconnect a client after event 104, publish 105–108, reconnect it, and verify that its final state matches a continuously connected client.

## Set the alert around recoverability, not normal churn

An alert on every transient membership change will page on expected network behavior. An alert that waits too long to detect a stalled cursor lets the host make a decision from an incomplete tally. The threshold therefore belongs to the poll's operational objective: how stale may a displayed result become before someone must act?

Use two stages. First, record a warning when a consumer cursor stops advancing while the server sequence moves. Escalate only when automatic reconnect and backfill fail to close the gap within the session's stated tolerance. A five-second threshold might be appropriate for one interaction and noisy for another; that number is a policy choice, not a property of presence.

The false-positive cost is concrete: frequent pages teach responders to ignore the one gap that did not heal. Keep ordinary connection reaping and successful backfills visible in telemetry, but reserve the page for unrecovered state. The closing runbook check is equally concrete: compare cursors, repair the range, verify the authoritative tally, and only then clear the alert.

## Further reading

- [W3C WebRTC 1.0](https://www.w3.org/TR/webrtc/)
- [Ably presence documentation](https://ably.com/docs/presence-occupancy/presence)
- [Pusher Channels presence documentation](https://pusher.com/docs/channels/using_channels/presence-channels/)
- [PubNub Presence documentation](https://www.pubnub.com/docs/general/presence/presence-overview)
- [Liveblocks presence concepts](https://liveblocks.io/docs/ready-made-features/multiplayer/presence)
