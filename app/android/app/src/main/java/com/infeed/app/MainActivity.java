package com.infeed.app;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Allow the WebView to be inspected from chrome://inspect on the desktop.
        WebView.setWebContentsDebuggingEnabled(true);
    }
}
